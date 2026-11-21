import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { ApiError } from "../src/lib/api";
import { NVDAB, TSLAB } from "./fixtures/mix-fixtures";

// C3 審查 #133：入金要記成 funding lot、匯入後調比例要送 assets、Idempotency-Key 存在 sessionStorage、停利停損用整數 bps。

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
const g = globalThis as unknown as { window?: { localStorage: MemoryStorage }; sessionStorage?: MemoryStorage; localStorage?: MemoryStorage };
const before = { window: g.window, sessionStorage: g.sessionStorage, localStorage: g.localStorage };
beforeAll(() => {
  g.sessionStorage ??= new MemoryStorage();
  g.localStorage ??= new MemoryStorage();
  g.window ??= { localStorage: g.localStorage };
});
// 其他測試檔共用同一個 process：放回原樣，不讓這裡的假 window 影響它們。
afterAll(() => {
  for (const key of ["window", "sessionStorage", "localStorage"] as const) {
    if (before[key] === undefined) delete (g as Record<string, unknown>)[key];
    else (g as Record<string, unknown>)[key] = before[key];
  }
});
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const chain = () => import("../src/features/mix/mix-chain");
const draftModule = () => import("../src/features/mix/mix-draft");
const noWait = async () => {};
const TX = `0x${"cd".repeat(32)}`;

test("1. money put into a mix is recorded as that mix's funding lot, with the mix's portfolio id", async () => {
  const { recordMixFunding, pendingMixFunding } = await chain();
  const seen: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ id: "1" }), { status: 200 });
  }) as typeof fetch;
  expect(await recordMixFunding({ token: "tok", mixId: 7, portfolioId: 90, source: { kind: "wallet_transfer", txHash: TX }, wait: noWait })).toBe(true);
  expect(seen).toEqual([{ url: "/api/portfolios/90/funding-lots", body: { source: { kind: "wallet_transfer", txHash: TX } } }]);
  expect(pendingMixFunding(7)).toEqual([]);
});

test("1. a receipt the backend cannot see yet is retried; if it never lands, it waits to be recorded later", async () => {
  const { recordMixFunding, pendingMixFunding, settlePendingMixFunding } = await chain();
  let calls = 0;
  const notYet = async () => { calls += 1; throw new ApiError(409, "FUNDING_NOT_CONFIRMED", "x"); };
  expect(await recordMixFunding({ token: "tok", mixId: 8, portfolioId: 91, source: { kind: "faucet_claim", claimId: "55" }, attempts: 3, wait: noWait, post: notYet as never })).toBe(false);
  expect(calls).toBe(3);
  expect(pendingMixFunding(8)).toEqual([{ kind: "faucet_claim", claimId: "55" }]);
  // 下次打開組合頁補記：記好就清掉。
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  expect(await settlePendingMixFunding("tok", 8, 91)).toBe(1);
  expect(pendingMixFunding(8)).toEqual([]);
});

test("1. a funding source that can never count is dropped, not retried forever", async () => {
  const { recordMixFunding, pendingMixFunding } = await chain();
  const conflict = async () => { throw new ApiError(409, "MIX_FUNDING_ALREADY_CARRIED", "x"); };
  expect(await recordMixFunding({ token: "tok", mixId: 9, portfolioId: 92, source: { kind: "wallet_transfer", txHash: TX }, wait: noWait, post: conflict as never })).toBe(true);
  expect(pendingMixFunding(9)).toEqual([]);
});

test("1. both buy and Add money go through fundMix, which records the lot", () => {
  const fs = require("node:fs");
  const builder = fs.readFileSync("src/features/mix/MixBuilderPage.tsx", "utf8") as string;
  const page = fs.readFileSync("src/features/mix/MixPage.tsx", "utf8") as string;
  const source = fs.readFileSync("src/features/mix/mix-chain.ts", "utf8") as string;
  expect(builder).toContain("await fundMix({");
  expect(page).toContain("await fundMix({");
  expect(page).toContain("settlePendingMixFunding(token, mix.id, mix.portfolioId)");
  expect(builder).not.toMatch(/sendUsdtToMix|claimTestUsdtToMix/);
  expect(page).not.toMatch(/sendUsdtToMix|claimTestUsdtToMix/);
  expect(source).toContain("return { recorded: await recordMixFunding({ token: args.token, mixId: args.mixId, portfolioId: args.portfolioId, source }) };");
});

test("2. changing a weight after opening a shared mix sends the new weights, not the share code", async () => {
  const { useMixDraft, createBody } = await draftModule();
  const d = useMixDraft.getState();
  d.reset({ symbols: ["NVDAB", "TSLAB"], weights: [5000, 5000], importCode: "aiBitcoinMix0000000000001", name: "AI" });
  expect(createBody(useMixDraft.getState(), "AI", "2026-11-21")).toMatchObject({ importCode: "aiBitcoinMix0000000000001" });
  expect(createBody(useMixDraft.getState(), "AI", "2026-11-21").assets).toBeUndefined();
  useMixDraft.getState().step(0, 1);
  const body = createBody(useMixDraft.getState(), "AI", "2026-11-21");
  expect(body.importCode).toBeUndefined();
  expect(body.assets).toEqual([{ assetId: NVDAB, weightBps: 5500 }, { assetId: TSLAB, weightBps: 4500 }]);
  expect(body).toMatchObject({ name: "AI", rebalance: { frequency: "monthly", startDate: "2026-11-21" }, exit: { takeProfitBps: null, stopLossBps: null } });
  useMixDraft.getState().reset({ symbols: ["NVDAB", "TSLAB"], weights: [5000, 5000], importCode: "aiBitcoinMix0000000000001" });
  useMixDraft.getState().setWeightAt(1, 7000);
  expect(useMixDraft.getState().importCode).toBeNull();
});

test("3. the Idempotency-Key lives in the saved draft: same body after a reload reuses it, a new body gets a new one", async () => {
  const { useMixDraft, creationKey, createBody } = await draftModule();
  useMixDraft.getState().reset({ symbols: ["NVDAB"], weights: [10000] });
  let n = 0;
  const next = () => `key-${++n}`;
  const body = createBody(useMixDraft.getState(), "NVDA", "2026-11-21");
  expect(creationKey(body, next)).toBe("key-1");
  // 存進 sessionStorage（重整、登入跳轉回來讀的就是這份）。
  expect(JSON.parse(g.sessionStorage!.getItem("cre8.mixDraft")!).state.creation.key).toBe("key-1");
  expect(creationKey(createBody(useMixDraft.getState(), "NVDA", "2026-11-21"), next)).toBe("key-1");
  expect(creationKey(createBody(useMixDraft.getState(), "Mine", "2026-11-21"), next)).toBe("key-2");
  // 建好清掉；reset 也清掉。
  useMixDraft.getState().set({ creation: null });
  expect(creationKey(body, next)).toBe("key-3");
  useMixDraft.getState().reset();
  expect(useMixDraft.getState().creation).toBeNull();
});

test("5. exit levels stay whole bps: 1234 bps survives an edit, and a rename sends no exit or dates", async () => {
  const { useMixDraft, editBody } = await draftModule();
  const base = { name: "Old", rebalance: { frequency: "monthly" as const, startDate: "2026-01-31" }, exit: { takeProfitBps: 1234, stopLossBps: 2000 } };
  useMixDraft.getState().reset({ symbols: ["NVDAB"], weights: [10000], editingId: 7, base, upBps: 1234, downBps: 2000, startDate: "2026-01-31" });
  // 只改名稱：不送 exit、不送 rebalance（舊的開始日在過去，送了會被擋）。
  expect(editBody(useMixDraft.getState(), "New", false)).toEqual({ name: "New" });
  // 只改停損：只送那一邊，停利原封不動不送。
  useMixDraft.getState().set({ downBps: 3000 });
  expect(editBody(useMixDraft.getState(), "Old", false)).toEqual({ exit: { stopLossBps: 3000 } });
  expect(Number.isInteger(useMixDraft.getState().upBps)).toBe(true);
  const fs = require("node:fs");
  const builder = fs.readFileSync("src/features/mix/MixBuilderPage.tsx", "utf8") as string;
  expect(builder).not.toMatch(/Bps \/ 100|Pct \* 100|upPct|downPct/);
});

test("re-check 2. Add money below the mix minimum is stopped before any USDT moves", async () => {
  const { addMoneyCheck, TEST_USDT_RAW } = await import("../src/features/mix/mix-math");
  const unit = 10n ** 18n;
  expect(addMoneyCheck(null, 50n * unit)).toBe("empty");
  expect(addMoneyCheck(0n, 50n * unit)).toBe("empty");
  expect(addMoneyCheck(49n * unit, 50n * unit)).toBe("below-minimum");
  expect(addMoneyCheck(50n * unit, 50n * unit)).toBe("ok");
  expect(addMoneyCheck(TEST_USDT_RAW, 50n * unit)).toBe("ok");
  const fs = require("node:fs");
  const page = fs.readFileSync("src/features/mix/MixPage.tsx", "utf8") as string;
  // 送出前擋（在 setState('busy') 與 fundMix 之前），按鈕也停用。
  const run = page.slice(page.indexOf("const run = async (testUsdt: boolean) => {"));
  expect(run.indexOf("addMoneyCheck(testUsdt ? TEST_USDT_RAW : value, minimum) !== 'ok'")).toBeLessThan(run.indexOf("await fundMix({"));
  expect(page).toContain("disabled={check !== 'ok' || short");
  expect(page).toContain("minimum={BigInt(preview.data?.minimumDepositRaw ?? FALLBACK_MINIMUM_RAW)}");
});

test("re-check 3. while a change is waiting, Add money is off; leftover funding is keyed by mix and sent to the newest portfolio", async () => {
  const { pendingMixFunding, settlePendingMixFunding } = await chain();
  // 舊版以 portfolioId 存的待補記：讀的時候搬到 mixId 底下。
  g.window!.localStorage.setItem("cre8.mixFunding.v1", JSON.stringify({ "90": [{ kind: "wallet_transfer", txHash: TX }] }));
  expect(pendingMixFunding(7, 90)).toEqual([{ kind: "wallet_transfer", txHash: TX }]);
  expect(JSON.parse(g.window!.localStorage.getItem("cre8.mixFunding.v1")!)).toEqual({ "m:7": [{ kind: "wallet_transfer", txHash: TX }] });
  // 改比例確認後 portfolioId 換成 95：補記送到 95。
  const sent: number[] = [];
  const post = (async (_token: string, portfolioId: number) => { sent.push(portfolioId); return {}; }) as never;
  expect(await settlePendingMixFunding("tok", 7, 95, { post })).toBe(1);
  expect(sent).toEqual([95]);
  expect(pendingMixFunding(7)).toEqual([]);
  const fs = require("node:fs");
  const page = fs.readFileSync("src/features/mix/MixPage.tsx", "utf8") as string;
  expect(page).toContain("disabled={exiting || mix.portfolioId === null || mix.pendingChange}");
  expect(page).toContain("Finishing your change…");
});
