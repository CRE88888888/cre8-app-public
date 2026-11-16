import { expect, test } from "bun:test";
import { decodeFunctionData, toFunctionSelector } from "viem";
import {
  buyAllowanceState,
  checkEnrollment,
  describePause,
  diffAllocations,
  explainA10Failure,
  pauseSourcesFromFlags,
  resumeNeedsWarning,
  sameAllocation,
  PLATFORM_PAUSED_MESSAGE,
} from "../src/lib/a10";
import { LEGACY_REGISTRY_ABI, P11_REGISTRY, REGISTRY_ABI, enrollCalldata, setPausedCalldata } from "../src/lib/atp-contracts";
import { CHAIN } from "../src/lib/kernel";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const BTCB = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ETH = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8";

test("calldata matches the registry signatures in cre8-contracts", () => {
  // P11（cre8-contracts#54）：只有三參數 enroll（帶預期版本）。
  const enroll = enrollCalldata(ACCOUNT, 7n, 3, true);
  expect(enroll.startsWith(toFunctionSelector("enroll(address,uint256,uint16)"))).toBe(true);
  expect(decodeFunctionData({ abi: REGISTRY_ABI, data: enroll }).args).toEqual([ACCOUNT, 7n, 3]);
  // 審查 #95 第 3 項：chain 56 的舊合約仍是二參數 enroll。
  const legacy = enrollCalldata(ACCOUNT, 7n, 3, false);
  expect(legacy.startsWith(toFunctionSelector("enroll(address,uint256)"))).toBe(true);
  expect(decodeFunctionData({ abi: LEGACY_REGISTRY_ABI, data: legacy }).args).toEqual([ACCOUNT, 7n]);
  // 預設跟這次 build 的鏈走：只有 chain 97 是 P11。
  expect(P11_REGISTRY).toBe(CHAIN.id === 97);
  expect(enrollCalldata(ACCOUNT, 7n, 3)).toBe(CHAIN.id === 97 ? enroll : legacy);

  const pause = setPausedCalldata(ACCOUNT, true);
  expect(pause.startsWith(toFunctionSelector("setPaused(address,bool)"))).toBe(true);
  expect(decodeFunctionData({ abi: REGISTRY_ABI, data: pause }).args).toEqual([ACCOUNT, true]);
  expect(decodeFunctionData({ abi: REGISTRY_ABI, data: setPausedCalldata(ACCOUNT, false) }).args).toEqual([ACCOUNT, false]);
});

test("pause flags decode to their sources", () => {
  expect(pauseSourcesFromFlags(0)).toEqual([]);
  expect(pauseSourcesFromFlags(1)).toEqual(["safe"]);
  expect(pauseSourcesFromFlags(2)).toEqual(["operator"]);
  expect(pauseSourcesFromFlags(4)).toEqual(["account"]);
  expect(pauseSourcesFromFlags(7)).toEqual(["safe", "operator", "account"]);
});

test("resuming warns only when someone else also paused the account", () => {
  expect(resumeNeedsWarning(["account"])).toBe(false);
  expect(resumeNeedsWarning([])).toBe(false);
  expect(resumeNeedsWarning(null)).toBe(false);
  expect(resumeNeedsWarning(["safe"])).toBe(true);
  expect(resumeNeedsWarning(["operator", "account"])).toBe(true);
  expect(describePause(["safe", "account"])).toContain("security council (Safe) and you");
  expect(describePause(null)).toBe("Trading for this account is paused.");
});

test("a version diff lists added, removed and re-weighted assets before unchanged ones", () => {
  const from = [
    { asset: USDT, weightBps: 1000 },
    { asset: BTCB, weightBps: 4500 },
    { asset: WBNB, weightBps: 4500 },
  ];
  const to = [
    { asset: USDT.toLowerCase(), weightBps: 1000 },
    { asset: BTCB, weightBps: 6000 },
    { asset: ETH, weightBps: 3000 },
  ];
  const diff = diffAllocations(from, to);
  expect(diff.map((row) => [row.kind, row.fromBps, row.toBps])).toEqual([
    ["changed", 4500, 6000],
    ["added", 0, 3000],
    ["removed", 4500, 0],
    ["same", 1000, 1000],
  ]);
  expect(sameAllocation(from, to)).toBe(false);
  expect(sameAllocation(from, [...from].reverse())).toBe(true);
});

test("the buy allowance is exhausted once the planner's 98% budget is spent and the window is still open", () => {
  const now = 1_794_000_000;
  const open = now + 3600;
  expect(buyAllowanceState({ cap: 1000n, bought: 980n, windowEndsAt: open }, now)).toEqual({ exhausted: true, remaining: 20n, nextBuyAt: open });
  expect(buyAllowanceState({ cap: 1000n, bought: 1000n, windowEndsAt: open }, now).exhausted).toBe(true);
  expect(buyAllowanceState({ cap: 1000n, bought: 979n, windowEndsAt: open }, now).exhausted).toBe(false);
  // 窗口過期：下一筆買入會開新窗口，不算用完。
  expect(buyAllowanceState({ cap: 1000n, bought: 1000n, windowEndsAt: now - 1 }, now)).toEqual({ exhausted: false, remaining: 0n, nextBuyAt: null });
  // 沒有開著的窗口，或帳戶沒 enroll（全 0）。
  expect(buyAllowanceState({ cap: 0n, bought: 0n, windowEndsAt: 0 }, now).exhausted).toBe(false);
});

test("contract errors and backend reasons map to plain messages", () => {
  expect(explainA10Failure("closing the position failed: ExecutorPaused：Safe 已開啟全域暫停，這一輪全部 blocked")).toBe(PLATFORM_PAUSED_MESSAGE);
  expect(explainA10Failure("execution reverted: ExecutorPaused()")).toBe(PLATFORM_PAUSED_MESSAGE);

  const limit = explainA10Failure("規劃器擋下（不執行）：買入額度：cap 100 × 98% − bought 98 → 可買 0，windowEndsAt 1794614400；等待買入窗口結束");
  expect(limit).toContain("buy allowance is used up");
  expect(limit).toContain("Next buy time");
  expect(explainA10Failure("BuyLimitExceeded(980, 1000)", { nextBuyAt: null })).toContain("Selling and withdrawing still work");

  const paused = explainA10Failure("execution reverted: Paused()", { pauseSources: ["operator"] });
  expect(paused).toContain("paused by the platform operator");
  expect(paused).toContain("My position");

  expect(explainA10Failure("BEP20: transfer amount exceeds balance")).toBeNull();
  expect(explainA10Failure("schedule_state is paused in the database")).toBeNull();
});

test("the pre-deposit check refuses an enrollment that is not the fund on screen", () => {
  const allocation = [
    { asset: USDT, weightBps: 1000 },
    { asset: BTCB, weightBps: 9000 },
  ];
  const base = { expectedStrategyId: 3n, onchainStrategyId: 3n, onchainVersion: 2, onchainAllocation: allocation, expectedAllocation: allocation };
  expect(checkEnrollment(base)).toEqual({ ok: true });
  expect(checkEnrollment({ ...base, expectedAllocation: null })).toEqual({ ok: true });
  expect(checkEnrollment({ ...base, onchainVersion: 0 }).ok).toBe(false);

  const wrongFund = checkEnrollment({ ...base, onchainStrategyId: 9n });
  expect(wrongFund.ok).toBe(false);
  expect(wrongFund.ok === false && wrongFund.reason).toContain("#9");

  const wrongAssets = checkEnrollment({ ...base, onchainAllocation: [{ asset: USDT, weightBps: 1000 }, { asset: ETH, weightBps: 9000 }] });
  expect(wrongAssets.ok).toBe(false);
});

// ── 舊合約（A10 之前）沒有這些函式：讀取要安靜地回 null，不是 false 或 0 ──────────────
import type { PublicClient } from "viem";
import { readBuyAllowance, readGlobalPaused, readOnchainAccount } from "../src/lib/atp-contracts";

const EXECUTOR = "0x3333333333333333333333333333333333333333" as const;
const REGISTRY = "0x4444444444444444444444444444444444444444" as const;

/** 只認得 `known` 裡的函式，其餘一律 revert（模擬舊合約）。 */
function fakeClient(known: Record<string, (args: readonly unknown[]) => unknown>): PublicClient {
  return {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      const handler = known[functionName];
      if (handler === undefined) throw new Error(`execution reverted: ${functionName} does not exist`);
      return handler(args ?? []);
    },
  } as unknown as PublicClient;
}

test("on a pre-A10 deployment the new reads are null, never false or zero", async () => {
  const old = fakeClient({});
  expect(await readGlobalPaused(old, EXECUTOR)).toBeNull();
  expect(await readBuyAllowance(old, EXECUTOR, ACCOUNT)).toBeNull();
});

test("the account state still reads when only pauseFlags is missing", async () => {
  const client = fakeClient({
    registry: () => REGISTRY,
    enrollments: () => ({ strategyId: 3n, version: 1, paused: true }),
    activeVersion: () => 2,
    version: (args) =>
      args[1] === 1
        ? { assets: [USDT, BTCB], weightsBps: [1000, 9000], scheduleHash: "0x", activeAt: 0n }
        : { assets: [USDT, ETH], weightsBps: [2000, 8000], scheduleHash: "0x", activeAt: 0n },
  });
  const state = await readOnchainAccount(client, EXECUTOR, ACCOUNT);
  expect(state.registry).toBe(REGISTRY);
  expect(state.pauseFlags).toBeNull();
  expect(state.paused).toBe(true);
  expect([state.strategyId, state.version, state.latestVersion]).toEqual([3n, 1, 2]);
  expect(state.current).toEqual([{ asset: USDT, weightBps: 1000 }, { asset: BTCB, weightBps: 9000 }]);
  expect(state.latest).toEqual([{ asset: USDT, weightBps: 2000 }, { asset: ETH, weightBps: 8000 }]);
});

test("an account that is not enrolled reads as version 0 without touching versions", async () => {
  const client = fakeClient({
    registry: () => REGISTRY,
    enrollments: () => ({ strategyId: 0n, version: 0, paused: false }),
    pauseFlags: () => 0,
  });
  const state = await readOnchainAccount(client, EXECUTOR, ACCOUNT);
  expect(state.version).toBe(0);
  expect(state.current).toBeNull();
  expect(state.pauseFlags).toBe(0);
});
