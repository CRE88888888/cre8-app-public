import { expect, test } from "bun:test";
import fs from "node:fs";
import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";
import { TESTNET_97 } from "../src/lib/testnet-97";
import type { AssetYield, PortfolioYield, YieldCall } from "../src/lib/yield";
import { yieldBookFor } from "../src/lib/yield-book";
import { YieldFlowStopped, YieldSigningPaused, runYieldFlow, type FlowDeps } from "../src/lib/yield-flow";
import { MOCK_MARKETS_97 } from "../src/lib/yield-mock";
import { pendingKey, readPendingRecords, savePendingRecord, type PendingRecord } from "../src/lib/yield-pending";
import { BundlerRejected, broadcastPrepared, isBundlerRejection } from "../src/lib/userop-send";

// cre8-app#95 第三輪複審（rv-yield-app3）R1–R6。每項先有修前會失敗的測試。

const BOOK = yieldBookFor(97)!;
const usdt = MOCK_MARKETS_97.markets.find((m) => m.id === "venus_usdt")!;
const H = (c: string) => `0x${c.repeat(64)}`;

const row = (over: Partial<AssetYield> = {}): AssetYield => ({
  asset: usdt.asset, symbol: "USDT", market: usdt.id, state: "not_consented", receiptValue: null, pending: null, dataAt: null,
  claimAssets: null, maxWithdraw: null, valuationState: null, consented: null, ...over,
});
const portfolio = (assets: AssetYield[]): PortfolioYield => ({ permission: "ok", accountValue: null, assets });

const seventeen = (() => {
  const seen = new Set<string>();
  return MOCK_MARKETS_97.markets.filter((m) => (seen.has(m.asset) ? false : (seen.add(m.asset), true))).slice(0, 17);
})();

function memoryStore() {
  const records = new Map<string, PendingRecord>();
  return { records, save: (r: PendingRecord) => void records.set(r.userOpHash, { ...r }), remove: (h: string) => void records.delete(h) };
}

function flow(over: Partial<FlowDeps>, rows: AssetYield[]) {
  const signed: YieldCall[][] = [];
  const store = memoryStore();
  const d: FlowDeps = {
    kind: "consent",
    wanted: rows.map((r) => r.market),
    chainId: 97,
    executor: TESTNET_97.contracts.executor,
    book: BOOK,
    retryDelayMs: 0,
    reload: async () => ({ data: portfolio(rows), markets: MOCK_MARKETS_97 }),
    notify: async () => undefined,
    store,
    hasUnresolved: () => false,
    sign: async (calls, onSubmitted) => {
      signed.push([...calls]);
      const h = H(String(signed.length));
      onSubmitted(h);
      return { userOpHash: h, txHash: H("f"), success: true };
    },
    ...over,
  };
  return { d, signed, store };
}

test("R1 the UserOp hash is saved before it is broadcast; a lost reply or timeout stays submitted, only a bundler rejection counts as not sent", async () => {
  const order: string[] = [];
  const returned = await broadcastPrepared({
    userOpHash: H("a"),
    onSubmitted: (h) => order.push(`saved ${h.slice(0, 4)}`),
    broadcast: async () => { order.push("broadcast"); return H("a") as `0x${string}`; },
  });
  expect(order).toEqual(["saved 0xaa", "broadcast"]);
  expect(returned).toBe(H("a"));
  // 回應遺失／逾時：原錯誤丟出（不是 BundlerRejected），hash 已經存了。
  const lost = await broadcastPrepared({ userOpHash: H("b"), onSubmitted: () => undefined, broadcast: async () => { throw new TimeoutError({ body: {}, url: "x" }); } }).catch((e) => e);
  expect(lost).toBeInstanceOf(TimeoutError);
  const network = new HttpRequestError({ url: "x", details: "fetch failed" });
  expect(isBundlerRejection(network)).toBe(false);
  // bundler 明確回 JSON-RPC 錯誤：確定沒收。
  const rpc = new RpcRequestError({ body: {}, url: "x", error: { code: -32500, message: "AA23 reverted" } });
  expect(isBundlerRejection(rpc)).toBe(true);
  const rejected = await broadcastPrepared({ userOpHash: H("c"), onSubmitted: () => undefined, broadcast: async () => { throw rpc; } }).catch((e) => e);
  expect(rejected).toBeInstanceOf(BundlerRejected);
  // 流程：第二批送出回應遺失 → submitted 留著、不算沒送；被 bundler 拒絕 → 刪掉記錄、算沒送。
  const rows = seventeen.map((m) => row({ asset: m.asset, symbol: m.symbol, market: m.id }));
  const lostFlow = flow({
    sign: async (calls, onSubmitted) => {
      if (calls.length === 2) { onSubmitted(H("d")); throw new TimeoutError({ body: {}, url: "x" }); }
      onSubmitted(H("1"));
      return { userOpHash: H("1"), txHash: H("f"), success: true };
    },
  }, rows);
  const stopped = (await runYieldFlow(lostFlow.d).catch((e) => e)) as YieldFlowStopped;
  expect(stopped.done).toHaveLength(16);
  expect(stopped.submitted).toHaveLength(1);
  expect(stopped.notSent).toHaveLength(0);
  expect([...lostFlow.store.records.values()].map((r) => r.state)).toEqual(["submitted"]);
  const rejectFlow = flow({ sign: async (_c, onSubmitted) => { onSubmitted(H("e")); throw new BundlerRejected(H("e"), rpc); } }, [row()]);
  const rejectedStop = (await runYieldFlow(rejectFlow.d).catch((e) => e)) as YieldFlowStopped;
  expect(rejectedStop.submitted).toHaveLength(0);
  expect(rejectedStop.notSent.map((r) => r.market)).toEqual(["venus_usdt"]);
  expect(rejectFlow.store.records.size).toBe(0);
  const kernel = fs.readFileSync("src/lib/kernel.ts", "utf8");
  expect(kernel).toContain("getUserOperationHash(");
  expect(kernel).toContain("broadcastPrepared(");
  expect(kernel.indexOf("prepareUserOperation(")).toBeLessThan(kernel.indexOf("broadcastPrepared("));
  // 新路徑（生息、chain 97）本身不用會重新 prepare 的 sendUserOperation；舊路徑留給其他呼叫者（userop-path.test.ts）。
  const early = kernel.slice(kernel.indexOf("early: async (onSubmitted) => {"), kernel.indexOf("const receipt = await accountClient.waitForUserOperationReceipt"));
  expect(early).toContain("prepareUserOperation(");
  expect(early).not.toContain("accountClient.sendUserOperation(");
});

test("R2 every signature first re-reads the account's pending list; a submitted one from any tab stops it", async () => {
  const blocked = flow({ hasUnresolved: () => true }, [row()]);
  const stopped = (await runYieldFlow(blocked.d).catch((e) => e)) as YieldFlowStopped;
  expect(stopped.cause).toBeInstanceOf(YieldSigningPaused);
  expect(blocked.signed).toHaveLength(0);
  // 第一批之後另一個分頁送出了：第二批不簽。
  const rows = seventeen.map((m) => row({ asset: m.asset, symbol: m.symbol, market: m.id }));
  let checks = 0;
  const later = flow({ hasUnresolved: () => (checks += 1) > 1 }, rows);
  const stopped2 = (await runYieldFlow(later.d).catch((e) => e)) as YieldFlowStopped;
  expect(stopped2.cause).toBeInstanceOf(YieldSigningPaused);
  expect(later.signed).toHaveLength(1);
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("addEventListener('storage'");
  expect(panel).toContain("hasUnresolved: () => readPendingRecords(browserStorage(), storeKey).some((item) => item.state === 'submitted')");
});

test("R3 memory only holds changes that could not be stored; another tab's update or removal wins", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const key = pendingKey(97, "0x00000000000000000000000000000000000000c3", 1);
  const a: PendingRecord = { kind: "consent", markets: ["venus_usdt"], userOpHash: H("1"), txHash: null, state: "submitted" };
  savePendingRecord(storage, key, a);
  // 另一個分頁把它改成 confirmed：
  const confirmed = { ...a, txHash: H("2"), state: "confirmed" as const };
  store.set(key, JSON.stringify([confirmed]));
  expect(readPendingRecords(storage, key)).toEqual([confirmed]);
  // 另一個分頁刪掉：這裡也看不到，再存別筆也不會把它寫回來。
  store.delete(key);
  expect(readPendingRecords(storage, key)).toEqual([]);
  const b: PendingRecord = { ...a, userOpHash: H("3") };
  savePendingRecord(storage, key, b);
  expect(readPendingRecords(storage, key)).toEqual([b]);
});

test("R4 an old v1 record (landed, not recorded) is read and moved to v2 as confirmed with its txHash", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const key = pendingKey(97, "0x00000000000000000000000000000000000000c4", 9);
  const legacy = key.replace(".v2.", ".v1.");
  store.set(legacy, JSON.stringify([{ kind: "exit", markets: ["venus_usdt"], txHash: H("9") }, { kind: "bad" }]));
  const records = readPendingRecords(storage, key);
  expect(records).toEqual([{ kind: "exit", markets: ["venus_usdt"], userOpHash: H("9"), txHash: H("9"), state: "confirmed" }]);
  expect(store.has(legacy)).toBe(false);
  expect(JSON.parse(store.get(key)!)).toEqual(records);
});

test("R5 the loading and error views also show the Check status result", () => {
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  const early = panel.slice(panel.indexOf("if (view !== 'ready') {"), panel.indexOf("const data = lending.data as PortfolioYield;"));
  expect(early).toContain("<Outcome done={done} progress={progress} />");
});

test("R6 the earlier review test has no unused file read", () => {
  const source = fs.readFileSync("tests/yield-review.test.ts", "utf8");
  const first = source.slice(source.indexOf('test("#1 '), source.indexOf('test("#2 '));
  if (first.includes("const panel =")) expect(first).toMatch(/expect\(panel\)/);
});
