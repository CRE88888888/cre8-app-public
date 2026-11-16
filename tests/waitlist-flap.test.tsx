import { expect, test } from "bun:test";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/lib/api";
import { BOARD_ASSETS, BOARD_PLAYS, FlapBoard, flapPath, initialRows, nextChange, rowText } from "../src/features/waitlist/FlapBoard";
import { WaitlistScreen, joinWaitlist } from "../src/features/waitlist/WaitlistScreen";
import { INVITES_OPEN, INVITE_FAILED_NOTE, normalizeInviteCode, savePendingInvite, takePendingInvite } from "../src/lib/waitlist";

// 使用者 2026-11-16：waitlist 改成左表單、右淺色翻牌看板（方向 B）；邀請碼由營運頁產生，後端上線前輸入欄關閉。

test("a flap turns forward through the letters to the new one, and a row has fixed width", () => {
  expect(flapPath("A", "D")).toEqual(["B", "C", "D"]);
  expect(flapPath("A", "A")).toEqual([]);
  // 翻過頭會繞回空白再往後。
  expect(flapPath("9", "B")).toEqual(["·", " ", "A", "B"]);
  // 翻牌上沒有的字直接跳到。
  expect(flapPath("A", "é")).toEqual(["é"]);
  expect(rowText({ asset: "BTC", play: "HOLD" })).toBe("BTC   HOLD ");
  expect(rowText({ asset: "GOOGLEX", play: "STACKS" })).toBe("GOOGLESTACK");
  expect(rowText({ asset: "btc", play: "hold" })).toBe("BTC   HOLD ");
});

test("the board starts with CRE8 FUNDS and never shows the same asset twice", () => {
  const rows = initialRows(8);
  expect(rows[0]).toEqual({ asset: "CRE8", play: "FUNDS" });
  expect(new Set(rows.map((row) => row.asset)).size).toBe(8);
  // 只寫資產代號與策略名稱，沒有報酬、權重之類的數字。
  for (const row of rows.slice(1)) {
    expect(BOARD_ASSETS).toContain(row.asset as (typeof BOARD_ASSETS)[number]);
    expect(BOARD_PLAYS).toContain(row.play as (typeof BOARD_PLAYS)[number]);
  }
  let seed = 0;
  const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  let board = initialRows(8);
  for (let i = 0; i < 200; i += 1) {
    const { index, row } = nextChange(board, random);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(8);
    board = board.map((item, j) => (j === index ? row : item));
    expect(new Set(board.map((item) => item.asset)).size).toBe(8);
    expect(board.filter((item) => item.asset === "CRE8").length).toBeLessThanOrEqual(1);
  }
});

test("the screen shows the form beside the board; the board is decorative for screen readers", () => {
  const html = renderToStaticMarkup(<WaitlistScreen view="connect" handle={null} avatarUrl={null} />);
  expect(html).toContain('class="waitlist__panel"');
  expect(html).toContain('class="waitlist__board"');
  expect(html).toContain('role="img" aria-label="CRE8 board: assets and the strategies a fund can run on them"');
  expect((html.match(/class="flap"/g) ?? []).length + (html.match(/class="flap" data-blank/g) ?? []).length).toBeGreaterThan(0);
  expect(renderToStaticMarkup(<FlapBoard rows={3} />).match(/flap-board__row/g)?.length).toBe(3);
  // 看板在系統「減少動態」時不翻。
  const css = fs.readFileSync("src/styles/components.css", "utf8");
  expect(css).toContain(".signin-screen.waitlist, .waitlist__avatar, .flap__face { animation: none; }");
  expect(fs.readFileSync("src/features/waitlist/FlapBoard.tsx", "utf8")).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
});

test("invite codes stay hidden until the backend is ready", () => {
  expect(INVITES_OPEN).toBe(false);
  const html = renderToStaticMarkup(<WaitlistScreen view="connect" handle={null} avatarUrl={null} />);
  expect(html).not.toContain("invite code");
  expect(html).not.toContain("waitlist__invite");
  expect(fs.readFileSync(".env.production", "utf8")).not.toMatch(/^VITE_INVITES=/m);
});

test("codes are tidied, kept for one round trip through X sign-in, then used once", () => {
  expect(normalizeInviteCode("  cre8-abcd ")).toBe("CRE8-ABCD");
  for (const bad of ["", "ab", "has space", "x".repeat(33), "emoji🙂"]) expect(normalizeInviteCode(bad)).toBeNull();
  const store = new Map<string, string>();
  const storage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k) };
  savePendingInvite("CRE8-ABCD", storage);
  expect(takePendingInvite(storage)).toBe("CRE8-ABCD");
  expect(takePendingInvite(storage)).toBeNull();
});

test("a code is tried first; a bad code falls back to the normal waitlist and says so", async () => {
  const approved = { status: "approved", xHandle: "alice", joinedAt: "2026-11-16T00:00:00Z" };
  const waiting = { status: "waiting", xHandle: "alice", joinedAt: "2026-11-16T00:00:00Z" };
  const calls: string[] = [];
  const join = async () => { calls.push("join"); return waiting; };
  expect(await joinWaitlist("t", "GOOD", { join, redeem: async (_t, code) => { calls.push(`redeem ${code}`); return approved; } })).toEqual({ record: { status: "approved", xHandle: "alice", joinedAt: "2026-11-16T00:00:00Z" }, inviteFailed: false });
  expect(calls).toEqual(["redeem GOOD"]);
  calls.length = 0;
  // backend#131 的四種「碼不能用」：改走排隊；只有碼真的不能用時才提示（已放行的人不提示）。
  for (const [status, code] of [[404, "INVITE_INVALID"], [409, "INVITE_USED"], [410, "INVITE_EXPIRED"]] as const) {
    calls.length = 0;
    const bad = await joinWaitlist("t", "USED", { join, redeem: async () => { throw new ApiError(status, code, "x"); } });
    expect(bad).toEqual({ record: { status: "waiting", xHandle: "alice", joinedAt: "2026-11-16T00:00:00Z" }, inviteFailed: true });
    expect(calls).toEqual(["join"]);
  }
  const already = await joinWaitlist("t", "GOOD", { join: async () => approved, redeem: async () => { throw new ApiError(409, "ALREADY_APPROVED", "x"); } });
  expect(already).toEqual({ record: { status: "approved", xHandle: "alice", joinedAt: "2026-11-16T00:00:00Z" }, inviteFailed: false });
  // 限流、伺服器錯誤、沒有 X、網路斷：照常丟出去重試，碼放回去不弄丟。
  for (const failure of [new ApiError(429, "RATE_LIMITED", "x"), new ApiError(503, "UNAVAILABLE", "x"), new ApiError(409, "X_REQUIRED", "x"), new TypeError("offline")]) {
    const kept: string[] = [];
    calls.length = 0;
    await expect(joinWaitlist("t", "GOOD", { join, keep: (code) => kept.push(code), redeem: async () => { throw failure; } })).rejects.toBe(failure);
    expect(kept).toEqual(["GOOD"]);
    expect(calls).toEqual([]);
  }
  expect(fs.readFileSync("src/features/waitlist/WaitlistScreen.tsx", "utf8")).toContain("{ signal, keep: savePendingInvite }");
  // 沒有碼就只排隊。
  calls.length = 0;
  await joinWaitlist("t", null, { join });
  expect(calls).toEqual(["join"]);
  const html = renderToStaticMarkup(<WaitlistScreen view="waiting" handle="alice" avatarUrl={null} inviteFailed />);
  expect(html).toContain(INVITE_FAILED_NOTE);
});

test("the Connect button shows the X logo instead of the word, Follow has an arrow, and the extra lines are gone", () => {
  const html = renderToStaticMarkup(<WaitlistScreen view="connect" handle={null} avatarUrl={null} />);
  // 使用者 2026-11-16：按鈕是「Connect ＋ X logo」，不是「X logo＋Connect X」；報讀器仍念 Connect X。
  const button = html.slice(html.indexOf('<button type="button" class="btn block" data-method="x"'), html.indexOf("</button>") + 9);
  expect(button).toContain('aria-label="Connect X"');
  expect(button).toMatch(/>Connect <svg/);
  expect(button.match(/<svg/g)?.length).toBe(1);
  expect(button.replace(/aria-label="[^"]*"/, "")).not.toContain("Connect X");
  // Follow 也一樣：「on X」的 X 用 logo，前面不再多一個 logo；後面加開新分頁的箭頭。
  const follow = html.slice(html.indexOf('<a class="btn ghost block" data-method="follow"'), html.indexOf("</a>") + 4);
  expect(follow).toContain('aria-label="Follow @CRE8Finance on X (opens X)"');
  expect(follow).toMatch(/>Follow @CRE8Finance on <svg[^>]*><path[^>]*><\/path><\/svg> <svg class="waitlist__arrow"/);
  expect(follow.match(/<svg/g)?.length).toBe(2);
  // 拿掉上方的「Waitlist」小字與邀請碼下面那行說明。
  expect(html).not.toContain("waitlist__eyebrow");
  expect(html).not.toMatch(/>Waitlist</);
  expect(fs.readFileSync("src/features/waitlist/WaitlistScreen.tsx", "utf8")).not.toContain("so we know who the code is for");
});

test("cre8.finance is the waitlist and sends approved people to the app on tst; only the two domains are public", () => {
  const gate = fs.readFileSync("src/features/waitlist/WaitlistScreen.tsx", "utf8");
  // 使用者 2026-11-16：放行後直接進 tst 的 app，不再換成 landing。
  expect(gate).toContain("if (view === 'approved' && isLandingHost(window.location.hostname)) window.location.replace(`${APP_ORIGIN}/`);");
  expect(gate).not.toContain("window.location.replace('/landing/')");
  const wrangler = fs.readFileSync("wrangler.jsonc", "utf8");
  expect(wrangler).toContain('"workers_dev": false,');
  expect(wrangler).toContain('"preview_urls": false,');
});

test("every failure just says Connect failed with Try again, never that the spot is saved", () => {
  // 使用者 2026-11-16：失敗一律寫 Connect failed，不要讓人覺得問題很多。
  for (const view of ["not-saved", "no-token", "unavailable"] as const) {
    const html = renderToStaticMarkup(<WaitlistScreen view={view} handle="alice" avatarUrl={null} onRetry={() => {}} />);
    expect(html).toContain(">Connect failed</h1>");
    expect(html).toContain("Please try again.");
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain("You’re on the list");
    expect(html).not.toMatch(/couldn’t be reached|didn’t finish|isn’t available|Reload/);
  }
  expect(fs.readFileSync("src/features/waitlist/WaitlistScreen.tsx", "utf8")).toContain("Connect failed. Please try again.");
  const gate = fs.readFileSync("src/features/waitlist/WaitlistScreen.tsx", "utf8");
  expect(gate).toContain("window.setTimeout(() => setTokenTimedOut(true), TOKEN_WAIT_MS)");
  expect(gate).toContain("const failed = query.isError && errorCode === null && !query.isFetching;");
});
