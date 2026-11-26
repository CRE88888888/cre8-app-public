import { expect, test } from "bun:test";
import fs from "node:fs";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { TESTNET_97 } from "../src/lib/testnet-97";
import { YIELD_REGISTRY_ABI, YieldBookMismatch, YieldStateChanged, checkYieldRows, checkYieldSigning, type AssetYield, type PortfolioYield, type YieldCall } from "../src/lib/yield";
import { yieldBookFor } from "../src/lib/yield-book";
import { YieldFlowStopped, resolveSubmitted, runYieldFlow, type FlowDeps } from "../src/lib/yield-flow";
import { MOCK_MARKETS_97 } from "../src/lib/yield-mock";
import { pendingKey, readPendingRecords, removePendingRecord, savePendingRecord, userOpReceiptFrom, type PendingRecord } from "../src/lib/yield-pending";

// cre8-app#95 複審（rv-yield-app2）F1–F6。每項先有修前會失敗的測試。

const BOOK = yieldBookFor(97)!;
const EXECUTOR = TESTNET_97.contracts.executor;
const markets = MOCK_MARKETS_97.markets;
const usdtMarket = markets.find((m) => m.id === "venus_usdt")!;
const btcMarket = markets.find((m) => m.symbol === "BTCB")!;

const rowFor = (market: (typeof markets)[number], over: Partial<AssetYield> = {}): AssetYield => ({
  asset: market.asset,
  symbol: market.symbol,
  market: market.id,
  state: "not_consented",
  receiptValue: null,
  pending: null,
  dataAt: null,
  claimAssets: null,
  maxWithdraw: null,
  valuationState: null,
  consented: null,
  ...over,
});
const portfolio = (assets: AssetYield[]): PortfolioYield => ({ permission: "ok", accountValue: null, assets });

/** 17 個不同資產的市場（每個資產取一個），測分批。 */
const seventeen = (() => {
  const seen = new Set<string>();
  return markets.filter((m) => (seen.has(m.asset) ? false : (seen.add(m.asset), true))).slice(0, 17);
})();

function memoryStore() {
  const records = new Map<string, PendingRecord>();
  return {
    records,
    save: (record: PendingRecord) => void records.set(record.userOpHash, { ...record }),
    remove: (userOpHash: string) => void records.delete(userOpHash),
  };
}

function deps(over: Partial<FlowDeps>): { d: FlowDeps; signed: YieldCall[][]; counter: { reloads: number } } {
  const signed: YieldCall[][] = [];
  const counter = { reloads: 0 };
  let n = 0;
  const reload = over.reload ?? (async () => ({ data: portfolio([]), markets: MOCK_MARKETS_97 }));
  const sign: FlowDeps["sign"] = over.sign ?? (async (_calls, onSubmitted) => {
    n += 1;
    const userOpHash = `0x${String(n).padStart(64, "0")}`;
    onSubmitted(userOpHash);
    return { userOpHash, txHash: `0x${String(n).padStart(64, "f")}`, success: true };
  });
  const d: FlowDeps = {
    kind: "consent",
    wanted: [],
    chainId: 97,
    executor: EXECUTOR,
    book: BOOK,
    retryDelayMs: 0,
    hasUnresolved: () => false,
    notify: async () => undefined,
    store: memoryStore(),
    ...over,
    reload: async () => { counter.reloads += 1; return reload(); },
    sign: async (calls, onSubmitted) => { signed.push([...calls]); return sign(calls, onSubmitted); },
  };
  return { d, signed, counter };
}

test("F1 a status row must be the asset of its market in the address book; the name shown comes from the book", () => {
  // 審查 PoC：asset／symbol 是 BTCB，market 卻是 venus_usdt。
  const forged = rowFor(usdtMarket, { asset: btcMarket.asset, symbol: "BTCB" });
  expect(() => checkYieldRows(portfolio([forged]), BOOK)).toThrow(YieldBookMismatch);
  expect(() => checkYieldRows(portfolio([rowFor(usdtMarket, { market: "venus_nope" })]), BOOK)).toThrow(YieldBookMismatch);
  const named = checkYieldRows(portfolio([rowFor(usdtMarket, { symbol: "Tether!!" })]), BOOK);
  expect(named.assets[0]!.symbol).toBe("USDT");
  expect(() => checkYieldSigning({ chainId: 97, executor: EXECUTOR, registry: MOCK_MARKETS_97.registry, markets: [usdtMarket], rows: [forged] }, BOOK)).toThrow(YieldBookMismatch);
  expect(() => checkYieldSigning({ chainId: 97, executor: EXECUTOR, registry: MOCK_MARKETS_97.registry, markets: [usdtMarket], rows: [rowFor(usdtMarket)] }, BOOK)).not.toThrow();
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("checkYieldRows(");
});

test("F2 stop and withdraw everything is one UserOp with every requestExit, never split", async () => {
  const rows = seventeen.map((m) => rowFor(m, { state: "supplied" }));
  const d = deps({ kind: "exit", reload: async () => ({ data: portfolio(rows), markets: MOCK_MARKETS_97 }) });
  const done = await runYieldFlow(d.d);
  expect(d.signed).toHaveLength(1);
  expect(d.signed[0]).toHaveLength(17);
  expect(d.signed[0]!.every((call) => call.data.slice(0, 10) === toFunctionSelector("requestExit(bytes32)"))).toBe(true);
  expect(decodeFunctionData({ abi: YIELD_REGISTRY_ABI, data: d.signed[0]![16]!.data }).args).toEqual([seventeen[16]!.marketId]);
  expect(done).toHaveLength(17);
  // 30 個市場全退也是一筆（30 calls，在 32 內）。
  const all = markets.map((m) => rowFor(m, { state: "supplied", asset: m.asset }));
  const d30 = deps({ kind: "exit", reload: async () => ({ data: portfolio(all), markets: MOCK_MARKETS_97 }) });
  await runYieldFlow(d30.d);
  expect(d30.signed).toHaveLength(1);
  expect(d30.signed[0]).toHaveLength(30);
});

test("F3 the landed transaction is saved before the first notice and removed only after it is recorded; without storage it is kept in memory", async () => {
  const rows = [rowFor(usdtMarket)];
  const store = memoryStore();
  const seen: PendingRecord[][] = [];
  const d = deps({
    wanted: ["venus_usdt"],
    store,
    reload: async () => ({ data: portfolio(rows), markets: MOCK_MARKETS_97 }),
    notify: async () => { seen.push([...store.records.values()]); },
  });
  await runYieldFlow(d.d);
  expect(seen[0]).toHaveLength(1);
  expect(seen[0]![0]).toMatchObject({ state: "confirmed", kind: "consent", markets: ["venus_usdt"] });
  expect(seen[0]![0]!.txHash).toMatch(/^0x[f0-9]{64}$/);
  expect(store.records.size).toBe(0);
  // 通知一直失敗：記錄留著、原錯誤原樣丟出。
  const failing = memoryStore();
  const apiError = Object.assign(new Error("boom"), { status: 503, code: "YIELD_UNAVAILABLE" });
  const d2 = deps({ wanted: ["venus_usdt"], store: failing, reload: async () => ({ data: portfolio(rows), markets: MOCK_MARKETS_97 }), notify: async () => { throw apiError; } });
  const stopped = await runYieldFlow(d2.d).catch((e) => e);
  expect(stopped).toBeInstanceOf(YieldFlowStopped);
  expect((stopped as YieldFlowStopped).cause).toBe(apiError);
  expect([...failing.records.values()][0]).toMatchObject({ state: "confirmed" });
  // storage 不能用：記憶體保留，同一頁讀得到。
  const key = pendingKey(97, "0x00000000000000000000000000000000000000aa", 1);
  const record: PendingRecord = { kind: "consent", markets: ["venus_usdt"], userOpHash: `0x${"1".repeat(64)}`, txHash: `0x${"2".repeat(64)}`, state: "confirmed" };
  savePendingRecord(null, key, record);
  expect(readPendingRecords(null, key)).toEqual([record]);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  const key2 = pendingKey(97, "0x00000000000000000000000000000000000000bb", 1);
  savePendingRecord(broken, key2, record);
  expect(readPendingRecords(broken, key2)).toEqual([record]);
  removePendingRecord(null, key, record.userOpHash);
  expect(readPendingRecords(null, key)).toEqual([]);
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("{item.txHash}</span>");
});

test("F4 every batch re-reads and re-checks its own markets; a withdrawal started elsewhere stops the next batch and keeps what is done", async () => {
  const rows = seventeen.map((m) => rowFor(m));
  let call = 0;
  const d = deps({
    wanted: rows.map((r) => r.market),
    reload: async () => {
      call += 1;
      if (call === 1) return { data: portfolio(rows), markets: MOCK_MARKETS_97 };
      return { data: portfolio(rows.map((r, i) => (i === 0 ? { ...r, state: "exiting" as const } : r))), markets: MOCK_MARKETS_97 };
    },
  });
  const stopped = await runYieldFlow(d.d).catch((e) => e);
  expect(stopped).toBeInstanceOf(YieldFlowStopped);
  expect((stopped as YieldFlowStopped).cause).toBeInstanceOf(YieldStateChanged);
  expect(d.signed).toHaveLength(1);
  expect(d.counter.reloads).toBe(2);
  expect((stopped as YieldFlowStopped).done).toHaveLength(16);
  expect((stopped as YieldFlowStopped).notSent.map((r) => r.market)).toEqual([rows[16]!.market]);
  // 正常情況：兩批、每批前各讀一次。
  const ok = deps({ wanted: rows.map((r) => r.market), reload: async () => ({ data: portfolio(rows), markets: MOCK_MARKETS_97 }) });
  await runYieldFlow(ok.d);
  expect(ok.signed.map((b) => b.length)).toEqual([32, 2]);
  expect(ok.counter.reloads).toBe(2);
});

test("F5 a submitted UserOp is kept by its hash until its receipt is known; it is not counted as not sent and blocks signing again", async () => {
  const rows = [rowFor(usdtMarket)];
  const store = memoryStore();
  const d = deps({
    wanted: ["venus_usdt"],
    store,
    reload: async () => ({ data: portfolio(rows), markets: MOCK_MARKETS_97 }),
    sign: async (_calls, onSubmitted) => {
      onSubmitted(`0x${"a".repeat(64)}`);
      throw new Error("Timed out while waiting for the receipt");
    },
  });
  const stopped = (await runYieldFlow(d.d).catch((e) => e)) as YieldFlowStopped;
  expect(stopped).toBeInstanceOf(YieldFlowStopped);
  expect(stopped.submitted.map((r) => r.market)).toEqual(["venus_usdt"]);
  expect(stopped.notSent).toEqual([]);
  expect([...store.records.values()]).toEqual([{ kind: "consent", markets: ["venus_usdt"], userOpHash: `0x${"a".repeat(64)}`, txHash: null, state: "submitted" }]);
  // 用原 hash 對帳：還沒有 receipt → 等；成功 → 改成已確認、去通知；revert → 丟掉。
  const submitted = [...store.records.values()][0]!;
  expect(resolveSubmitted(submitted, null)).toEqual({ action: "wait" });
  expect(resolveSubmitted(submitted, { txHash: `0x${"b".repeat(64)}`, success: true })).toEqual({ action: "notify", record: { ...submitted, txHash: `0x${"b".repeat(64)}`, state: "confirmed" } });
  expect(resolveSubmitted(submitted, { txHash: `0x${"b".repeat(64)}`, success: false })).toEqual({ action: "drop" });
  expect(userOpReceiptFrom({ jsonrpc: "2.0", id: 1, result: null })).toBeNull();
  expect(userOpReceiptFrom({ result: { success: true, receipt: { transactionHash: `0x${"c".repeat(64)}` } } })).toEqual({ txHash: `0x${"c".repeat(64)}`, success: true });
  expect(() => userOpReceiptFrom({ error: { message: "nope" } })).toThrow();
  const kernel = fs.readFileSync("src/lib/kernel.ts", "utf8");
  expect(kernel).toContain("onSubmitted: args.onSubmitted,");
  expect(kernel).toContain("eth_getUserOperationReceipt");
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("const unresolved = unrecorded.some((item) => item.state === 'submitted');");
  expect(panel).toContain("Check status");
});
