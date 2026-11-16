import { expect, test } from "bun:test";
import fs from "node:fs";
import {
  MIN_SUBSCRIPTION_USDT,
  STACK_MIN_BUY_NOTE,
  STACK_MIN_BUY_USDT,
  minimumDeposit,
  minimumDepositFor,
  STACK_SLICES,
  clampSlices,
  describeExecutionProblem,
  stackPlan,
  stackBuys,
  stackExecution,
  stackSlicesLimit,
  usdtText,
} from "../src/lib/fund-execution";
import { FEATURES } from "../src/lib/feature-flags";
import * as B from "../src/reference/lib/fund-builder";

// 定期定額期數「最長一年」（使用者 2026-11-16 定案；db#52、backend#118）。
const NOW = new Date(2026, 10, 16, 12);
const stack = B.defaults("stack");

test("limits follow the frequency: daily 2–365, weekly 2–52", () => {
  expect(STACK_SLICES).toEqual({ daily: { min: 2, max: 365 }, weekly: { min: 2, max: 52 } });
  expect(stackSlicesLimit("daily")).toEqual({ min: 2, max: 365 });
  expect(stackSlicesLimit("weekly")).toEqual({ min: 2, max: 52 });
});

test("daily accepts 365 and rejects 366", () => {
  expect(stackExecution({ ...stack, every: "daily", buys: 365 }, NOW)?.slices).toBe(365);
  expect(stackExecution({ ...stack, every: "daily", buys: 366 }, NOW)).toBeNull();
  expect(stackExecution({ ...stack, every: "daily", buys: 1 }, NOW)).toBeNull();
});

test("weekly accepts 52 and rejects 53", () => {
  expect(stackExecution({ ...stack, every: "weekly", buys: 52 }, NOW)?.slices).toBe(52);
  expect(stackExecution({ ...stack, every: "weekly", buys: 53 }, NOW)).toBeNull();
  // 舊草稿：每週 365 期不能啟用。
  expect(stackExecution({ ...stack, every: "weekly", buys: 365 }, NOW)).toBeNull();
});

test("switching daily to weekly clamps to 52 and says so", () => {
  expect(clampSlices("weekly", 365)).toEqual({ buys: 52, clamped: true });
  expect(clampSlices("weekly", 53)).toEqual({ buys: 52, clamped: true });
  expect(clampSlices("weekly", 52)).toEqual({ buys: 52, clamped: false });
  expect(clampSlices("daily", 52)).toEqual({ buys: 52, clamped: false });
  expect(clampSlices("daily", 365)).toEqual({ buys: 365, clamped: false });
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  // 夾值會被看到：記下原本幾期，畫面寫出「N buys became 52」。
  expect(designer).toContain("setClamped(next.clamped ? p.buys : null);");
  expect(designer).toContain("so {clamped} buys became {stackSlicesLimit(\"weekly\").max}.");
});

test("each buy is at least 10 USDT; a small amount gets fewer buys (about M = min(N, floor(amount / 10)))", () => {
  expect(STACK_MIN_BUY_USDT).toBe(10);
  // docs#71 的例子：設 12 期、投 100 → 約 10 期各 10。
  expect(stackPlan(100, 10_000, 12)).toEqual({ buys: 10, perBuy: 10 });
  expect(stackPlan(50, 10_000, 12)).toEqual({ buys: 5, perBuy: 10 });
  expect(stackPlan(600, 10_000, 12)).toEqual({ buys: 12, perBuy: 50 });
  // 金額夠多：不超過創作者設的期數。
  expect(stackPlan(10_000, 5_000, 52)).toEqual({ buys: 52, perBuy: 5_000 / 52 });
  // 分到的不到 10：至少 1 期。
  expect(stackPlan(40, 2_000, 365)).toEqual({ buys: 1, perBuy: 8 });
  expect(stackPlan(0, 5_000, 10)).toEqual({ buys: 0, perBuy: 0 });
  expect(usdtText(50)).toBe("50.00");
  expect(usdtText(0.137)).toBe("0.137");
});

test("minimum deposit is max(50, ceil(10 / (1 − cash))); a small asset weight does not raise it", () => {
  expect(MIN_SUBSCRIPTION_USDT).toBe(50);
  const BTC = "0xbtc", ETH = "0xeth", USDT = "0xusdt";
  // 現金 50% → 50（最小認購）。
  expect(minimumDeposit([{ address: BTC, weightBps: 5_000 }, { address: USDT, weightBps: 5_000 }], USDT)).toBe(50);
  // 現金 90% → 10 / 0.1 = 100。
  expect(minimumDeposit([{ address: BTC, weightBps: 1_000 }, { address: USDT, weightBps: 9_000 }], USDT)).toBe(100);
  // 現金 95% → 200。
  expect(minimumDepositFor([500])).toBe(200);
  // 全現金：最小認購 50。
  expect(minimumDeposit([{ address: USDT, weightBps: 10_000 }], USDT)).toBe(50);
  // 最小權重 0.5%：投 50 的那份只有 0.25 USDT，後端留到下一期再買，不抬高最低投入 → 50。
  expect(minimumDeposit([{ address: BTC, weightBps: 9_950 }, { address: ETH, weightBps: 50 }], USDT)).toBe(50);
  expect(minimumDepositFor([9_970, 30])).toBe(50);
  // 現金 70% → ceil(33.33…) 仍低於 50。
  expect(minimumDepositFor([3_000])).toBe(50);
  // 現金 83% → ceil(58.82…) = 59：整 USDT 向上取整，與後端 minimumAssetContribution 相同。
  expect(minimumDepositFor([1_700])).toBe(59);
  // 設計器用列的權重算。
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(designer).toContain("const fallback = minimumDepositFor(rows.map((item) => Math.round(item.share * 100)));");
});

test("the per-batch rule replaces the old under-1-USDT note, from one constant", () => {
  expect(STACK_MIN_BUY_NOTE).toBe("Each buy is at least 10 USDT. When the amount is too small, it is split into fewer buys automatically.");
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  for (const source of [designer, page]) {
    expect(source).toContain("{STACK_MIN_BUY_NOTE}");
    expect(source).not.toMatch(/under 1 USDT|smallBuyNote|(?<!STACK_)MIN_BUY_USDT\b/);
    // 數字不寫死在畫面文案裡。
    expect(source).not.toMatch(/least (10|50) USDT/);
  }
  expect(designer).toContain("this asset is bought in {plan.about}{plan.buys}");
  // 測試網 gas 由平台全付：不顯示 gas 佔比。
  expect(designer).not.toMatch(/gas share|of it is gas|% gas/i);
});

test("the buyer page reads each stack asset from the version and uses the real amount", () => {
  const execution = {
    kind: "per_asset",
    numeraire: "0xusdt",
    rebalance: "none",
    assets: [
      { asset: "0xusdt", weightBps: 1_000, yield: null },
      { asset: "0xbtc", weightBps: 6_000, execution: { kind: "stack", every: "weekly", weekday: 1, timeUtc: "01:00", slices: 12 }, yield: null },
      { asset: "0xeth", weightBps: 3_000, execution: { kind: "stack", every: "daily", weekday: null, timeUtc: "01:00", slices: 365 }, yield: null },
      { asset: "0xbnb", weightBps: 0, execution: { kind: "hold" }, yield: null },
    ],
  };
  // 1,000 USDT：BTC 600 → 12 期每期 50；ETH 300 → 30 期每期 10（少於設的 365）。
  expect(stackBuys(execution, 1_000)).toEqual([
    { asset: "0xbtc", every: "weekly", slices: 12, buys: 12, perBuy: 50, about: true },
    { asset: "0xeth", every: "daily", slices: 365, buys: 30, perBuy: 10, about: true },
  ]);
  expect(stackBuys(execution, 0).every((buy) => buy.buys === 0)).toBe(true);
  expect(stackBuys({ kind: "target_weight" }, 100)).toEqual([]);
  expect(stackBuys(undefined, 100)).toEqual([]);
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  // 審查 #95 第 4、10 項：用生效中的那一版，金額傳原字（不經 Number）。
  expect(page).toContain("<StackBuyPreview execution={effective?.execution} amountText={");
  expect(page).toContain(": amount} />");
  expect(page).not.toContain("versions[0]?.execution");
});

test("copy says up to a year", () => {
  expect(FEATURES.strategyDca.note).toContain("up to a year (365 daily / 52 weekly buys)");
  expect(FEATURES.strategyDca.note).not.toContain("2–52");
  expect(describeExecutionProblem({ kind: "schedule", assets: ["ETH"] })).toContain("daily (2–365 buys) or weekly (2–52 buys)");
});
