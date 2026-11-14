import { expect, test } from "bun:test";
import fs from "node:fs";
import { hasRememberedOwner } from "../src/lib/privy-owner";
import { ENTRY_SEEN_KEY, entrySeen, markEntrySeen, shouldOpenEntry } from "../src/lib/sign-in-entry";
import type { EntryInput } from "../src/lib/sign-in-entry";

// 一打開 app 就先看到登入頁（Privy 模式）。

const fresh: EntryInput = { enabled: true, phase: "signed-out", sessionLive: false, seen: false, returning: false, pathname: "/vaults" };

function memory(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as unknown as Storage;
}

test("a new visitor sees the sign-in page as soon as the app opens", () => {
  expect(shouldOpenEntry(fresh)).toBe(true);
  // SDK 還在載入：新訪客不用等，先看到登入頁。
  expect(shouldOpenEntry({ ...fresh, phase: "loading" })).toBe(true);
  // 分享出去的基金連結也一樣（可以按 Browse first 先看）。
  expect(shouldOpenEntry({ ...fresh, pathname: "/funds/ai-leaders" })).toBe(true);
});

test("it stays out of the way when it is not needed", () => {
  // 沒設定 Privy：app 是原本的連錢包登入，沒有這一頁。
  expect(shouldOpenEntry({ ...fresh, enabled: false })).toBe(false);
  // 已經登入。
  expect(shouldOpenEntry({ ...fresh, sessionLive: true })).toBe(false);
  // 這個分頁已經跳過。
  expect(shouldOpenEntry({ ...fresh, seen: true })).toBe(false);
  // 登入過的裝置：等 Privy 確定沒有人登入才出現，登入頁不會閃一下又消失。
  expect(shouldOpenEntry({ ...fresh, phase: "loading", returning: true })).toBe(false);
  expect(shouldOpenEntry({ ...fresh, phase: "signed-out", returning: true })).toBe(true);
  // 登入進行中、已登入、出錯、SDK 載不起來：都不是「請登入」的時候。
  for (const phase of ["creating-wallet", "exchanging", "signed-in", "error", "unavailable"] as const) {
    expect(shouldOpenEntry({ ...fresh, phase })).toBe(false);
  }
  // 內部的營運後台。
  expect(shouldOpenEntry({ ...fresh, pathname: "/operator" })).toBe(false);
});

test("skipping is remembered for this tab only", () => {
  const storage = memory();
  expect(entrySeen(storage)).toBe(false);
  markEntrySeen(storage);
  expect(storage.getItem(ENTRY_SEEN_KEY)).toBe("1");
  expect(entrySeen(storage)).toBe(true);
  // storage 被擋也不會壞。
  expect(entrySeen(null)).toBe(false);
  expect(() => markEntrySeen(null)).not.toThrow();
  // 用的是 sessionStorage（關掉分頁就忘記），不是 localStorage。
  const store = fs.readFileSync("src/store/privy.ts", "utf8");
  expect(store).toContain("markEntrySeen(sessionStorageOrNull())");
  expect(store).not.toContain("localStorage");
});

test("a device counts as returning once an owner was remembered on it", () => {
  expect(hasRememberedOwner(memory())).toBe(false);
  expect(hasRememberedOwner(memory({ "cre8.privyOwner": "{}" }))).toBe(false);
  expect(hasRememberedOwner(memory({ "cre8.privyOwner": "not json" }))).toBe(false);
  expect(hasRememberedOwner(memory({ "cre8.privyOwner": '{"did:privy:1":"0x1111111111111111111111111111111111111111"}' }))).toBe(true);
  expect(hasRememberedOwner(null)).toBe(false);
});

test("the opening page is a page, not a popup: no close button, a way to browse first", () => {
  const screen = fs.readFileSync("src/components/SignInScreen.tsx", "utf8");
  expect(screen).toContain("{!signInEntry && (");
  expect(screen).toContain("onClick={signInEntry ? undefined : closeSignIn}");
  expect(screen).toContain("Browse first");
  // 使用者自己按 Sign in 打開的那一種不受影響。
  const store = fs.readFileSync("src/store/privy.ts", "utf8");
  expect(store).toContain("usePrivyAuth.setState({ signInOpen: true, signInEntry: false });");
});
