import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { activationDesign } from "../src/lib/activation-design";
import {
  EXECUTION_COPY,
  describeExecutionProblem,
  designExecution,
  executionConfirm,
  minimumDeposit,
  rebalanceOf,
  openKinds,
  rowExtras,
  stackExecution,
  stackWords,
  typedVersionBody,
} from "../src/lib/fund-execution";
import { MAINNET_STATUS, openTestnetCrypto } from "../src/lib/testnet-assets";
import { IS_TESTNET } from "../src/lib/testnet-catalogue";
import * as B from "../src/reference/lib/fund-builder";

// docs#57 G0-4（使用者 2026-11-15）：每個資產各自 hold 或 stack，stack 的排程逐資產由創作者設定；
// 送出 schema 2 的 per_asset 版本（backend BE-2）。

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const BTC = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";

// 時區固定成台北（UTC+8，沒有夏令時間），換算才有固定答案。
const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = "Asia/Taipei"; });
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
/** 2026-11-18 是星期三（台北中午）。 */
const NOW = new Date("2026-11-18T04:00:00Z");

const design = (plays: B.Play[]) => {
  let state = B.emptyBuilder();
  for (const [index, key] of ["BTC", "ETH", "SOL"].slice(0, plays.length).entries()) {
    state = B.addAsset(state, key, "demo");
    const row = state.rows[state.rows.length - 1]!;
    if (plays[index] !== "hold") state = B.setPlay(state, row.id, plays[index]!, "demo");
  }
  return { ...state, name: "Test fund" };
};
const BOTH = ["hold", "stack"] as const;

test("stack is open now that the backend takes the creator's schedule", () => {
  expect(openKinds()).toEqual(["hold", "stack"]);
  expect(openKinds(false)).toEqual(["hold"]);
});

test("a stack row's local schedule becomes the backend's UTC schedule", () => {
  const stack = B.defaults("stack");
  // 設計器預設：每週一 09:00、12 期。台北 09:00 = UTC 01:00，同一天（星期一 = 1）。
  expect(stackExecution(stack, NOW)).toEqual({ kind: "stack", every: "weekly", weekday: 1, timeUtc: "01:00", slices: 12 });
  // 台北星期一 07:00 是 UTC 星期日 23:00：星期跟著退一天（後端星期日 = 0）。
  expect(stackExecution({ ...stack, time: "07:00" }, NOW)).toEqual({ kind: "stack", every: "weekly", weekday: 0, timeUtc: "23:00", slices: 12 });
  // 設計器星期日（6）→ 後端 0。
  expect(stackExecution({ ...stack, day: 6, time: "12:30" }, NOW)?.weekday).toBe(0);
  expect(stackExecution({ ...stack, every: "daily", buys: 2 }, NOW)).toEqual({ kind: "stack", every: "daily", weekday: null, timeUtc: "01:00", slices: 2 });
  expect(stackExecution({ ...stack, buys: 52 }, NOW)?.slices).toBe(52);
  // 後端只收每天／每週、2–52 期。
  expect(stackExecution({ ...stack, every: "monthly" }, NOW)).toBeNull();
  expect(stackExecution({ ...stack, buys: 53 }, NOW)).toBeNull();
  expect(stackExecution({ ...stack, buys: 1 }, NOW)).toBeNull();
  expect(stackExecution({ ...stack, time: "9:00" }, NOW)).toBeNull();
});

test("the UTC schedule is told back in local time", () => {
  expect(stackWords({ kind: "stack", every: "weekly", weekday: 0, timeUtc: "23:00", slices: 12 }, NOW)).toBe("Every Monday at 07:00 your time, over 12 buys");
  expect(stackWords({ kind: "stack", every: "daily", weekday: null, timeUtc: "01:00", slices: 4 }, NOW)).toBe("Every day at 09:00 your time, over 4 buys");
});

test("each asset keeps its own strategy: hold and stack can sit in one fund", () => {
  const result = designExecution(design(["hold", "stack"]).rows, { open: BOTH, now: NOW });
  expect("assets" in result && result.rebalance).toBe("none");
  expect("assets" in result && Object.fromEntries(result.assets)).toEqual({
    BTC: { kind: "hold" },
    ETH: { kind: "stack", every: "weekly", weekday: 1, timeUtc: "01:00", slices: 12 },
  });
  expect(designExecution([], { open: BOTH })).toEqual({ assets: new Map(), rebalance: "none" });
});

test("what still blocks activation is named, one thing at a time", () => {
  const name = (play: string) => B.PLAYS[play as B.Play].name;
  // 還沒開放的策略先講。
  expect(designExecution(design(["dips", "stack"]).rows, { playName: name, open: BOTH })).toEqual({ problem: { kind: "excluded", plays: ["Buy dips"] } });
  for (const play of ["custom", "dips", "range", "trend", "lp", "carry"] as const) {
    const one = designExecution([{ key: "BTC", play, p: B.defaults(play) } as B.Row], { open: BOTH });
    expect("problem" in one && one.problem.kind).toBe("excluded");
  }
  // stack 關掉的話（功能開關），stack 也算還沒開放。
  expect(designExecution(design(["stack"]).rows, { playName: name, open: ["hold"] })).toEqual({ problem: { kind: "excluded", plays: ["Stack"] } });
  // 舊草稿的每月排程或 1000 期。
  const monthly = { key: "ETH", play: "stack", p: { ...B.defaults("stack"), every: "monthly" } } as B.Row;
  expect(designExecution([monthly], { open: BOTH, assetName: () => "ETH" })).toEqual({ problem: { kind: "schedule", assets: ["ETH"] } });
  expect(describeExecutionProblem({ kind: "schedule", assets: ["ETH"] })).toBe("Stack buys daily or weekly, in 2–52 buys. Change the schedule of ETH to activate this fund now.");
  // 同一個資產兩列、設定不同：後端一個資產一種設定。設定相同就合併。
  const hold = { key: "BTC", play: "hold", p: B.defaults("hold") } as B.Row;
  const stack = { key: "BTC", play: "stack", p: B.defaults("stack") } as B.Row;
  expect(designExecution([hold, stack], { open: BOTH, assetName: () => "BTCB" })).toEqual({ problem: { kind: "split", assets: ["BTCB"] } });
  expect(describeExecutionProblem({ kind: "split", assets: ["BTCB"] })).toBe("BTCB has two different strategies. Give each asset one strategy to activate this fund now.");
  expect(designExecution([hold, { ...hold, id: 9 }], { open: BOTH })).toEqual({ assets: new Map([["BTC", { kind: "hold" }]]), rebalance: "none" });
});

test("old hold/stack extras and whole-fund rules block activation until turned off; the draft keeps its fields", () => {
  const lending = { key: "BTC", play: "hold", p: { ...B.defaults("hold"), venue: "venus" } } as B.Row;
  const stops = { key: "BTC", play: "stack", p: { ...B.defaults("stack"), exit: "tpsl" } } as unknown as B.Row;
  const ceiling = { key: "BTC", play: "stack", p: { ...B.defaults("stack"), ceiling: 90_000 } } as B.Row;
  expect(rowExtras(lending)).toEqual(["Earn while held"]);
  expect(rowExtras(stops)).toEqual(["Take profit or stop loss"]);
  expect(rowExtras(ceiling)).toEqual(["Pause buying above a price"]);
  expect(designExecution([lending], { open: BOTH })).toEqual({ problem: { kind: "extras", settings: ["Earn while held"] } });
  expect(designExecution(design(["hold"]).rows, { rules: { rotate: { on: true } } })).toEqual({ problem: { kind: "extras", settings: ["Whole-fund rules"] } });
  expect("assets" in designExecution(design(["hold"]).rows, { rules: { rebalance: { on: false }, idle: { on: false } } })).toBe(true);
  expect(rowExtras({ play: "hold", p: B.defaults("hold") } as B.Row)).toEqual([]);
  expect(rowExtras({ play: "stack", p: B.defaults("stack") } as B.Row)).toEqual([]);
  expect(lending.p).toEqual({ ...B.defaults("hold"), venue: "venus" });
});

test("the version body is the backend's schema 2 per_asset shape", () => {
  const stack = { kind: "stack", every: "weekly", weekday: 1, timeUtc: "01:00", slices: 12 } as const;
  const body = typedVersionBody({ chainId: 97, usdt: USDT.toUpperCase().replace("0X", "0x"), changeLog: "x", assets: [
    { address: BTC.toUpperCase().replace("0X", "0x"), weightBps: 5000, execution: stack },
    { address: ETH, weightBps: 3000 },
    { address: USDT, weightBps: 2000 },
  ] });
  expect(body).toEqual({
    chainId: 97,
    allocation: { assets: [{ address: BTC, weightBps: 5000 }, { address: ETH, weightBps: 3000 }, { address: USDT, weightBps: 2000 }] },
    execution: {
      kind: "per_asset",
      numeraire: USDT,
      rebalance: "none",
      assets: [
        { asset: BTC, weightBps: 5000, execution: stack, yield: null },
        { asset: ETH, weightBps: 3000, execution: { kind: "hold" }, yield: null },
        { asset: USDT, weightBps: 2000, yield: null },
      ],
    },
    schedule: { kind: "funding" },
    idleYield: { enabled: false },
    changeLog: "x",
  });
  // USDT 沒選也要列（0%）：後端會把它補進 allocation，兩邊要一項一項對得上。
  const noCash = typedVersionBody({ chainId: 56, usdt: USDT, assets: [{ address: ETH, weightBps: 10_000 }] });
  expect(noCash.allocation.assets).toEqual([{ address: ETH, weightBps: 10_000 }, { address: USDT, weightBps: 0 }]);
  expect(noCash.execution.assets.at(-1)).toEqual({ asset: USDT, weightBps: 0, yield: null });
  expect("changeLog" in noCash).toBe(false);
  // 純 USDT 可以（沒有東西要買）。
  expect(typedVersionBody({ chainId: 97, usdt: USDT, assets: [{ address: USDT, weightBps: 10_000 }] }).execution.assets).toEqual([{ asset: USDT, weightBps: 10_000, yield: null }]);
});

test("a version that does not add up, lists an asset twice or stacks USDT is refused before anything is created", () => {
  expect(() => typedVersionBody({ chainId: 97, usdt: USDT, assets: [{ address: BTC, weightBps: 9_999 }] })).toThrow("99.99%");
  expect(() => typedVersionBody({ chainId: 97, usdt: USDT, assets: [] })).toThrow();
  expect(() => typedVersionBody({ chainId: 97, usdt: USDT, assets: [{ address: BTC, weightBps: 5_000 }, { address: BTC.toUpperCase().replace("0X", "0x"), weightBps: 5_000 }] })).toThrow("twice");
  expect(() => typedVersionBody({ chainId: 97, usdt: USDT, assets: [{ address: USDT, weightBps: 10_000, execution: { kind: "stack", every: "daily", weekday: null, timeUtc: "01:00", slices: 2 } }] })).toThrow("USDT");
});

test("the minimum deposit is 50 USDT of buys: cash does not count", () => {
  expect(minimumDeposit([{ address: BTC, weightBps: 10_000 }], USDT)).toBe(50);
  expect(minimumDeposit([{ address: BTC, weightBps: 5_000 }, { address: USDT, weightBps: 5_000 }], USDT)).toBe(100);
  expect(minimumDeposit([{ address: BTC, weightBps: 3_000 }, { address: USDT.toUpperCase().replace("0X", "0x"), weightBps: 7_000 }], USDT)).toBe(166.67);
  expect(minimumDeposit([{ address: USDT, weightBps: 10_000 }], USDT)).toBe(50);
});

test("a design reaches the activation page with each asset's strategy, keyed by token", () => {
  const mixed = activationDesign(design(["hold", "stack"]), false, NOW)!;
  expect(mixed.executionProblem).toBeNull();
  expect(mixed.executions).toEqual({
    [BTC]: { kind: "hold" },
    [ETH]: { kind: "stack", every: "weekly", weekday: 1, timeUtc: "01:00", slices: 12 },
  });
  expect(Object.values(mixed.weights).reduce((sum, value) => sum + value, 0)).toBe(100);
  const dips = activationDesign(design(["dips"]), false, NOW)!;
  expect(dips.executions).toBeNull();
  expect(dips.executionProblem).toContain("coming soon");
});

test("the copy names both strategies and the confirmation states only what this fund does", () => {
  expect(EXECUTION_COPY.stack.line).toMatch(/Holders only choose how much/);
  expect(executionConfirm(new Set(["hold"]))).toBe(EXECUTION_COPY.hold.confirm);
  expect(executionConfirm(new Set(["stack"]))).toBe(EXECUTION_COPY.stack.confirm);
  expect(executionConfirm(new Set(["hold", "stack"]))).toMatch(/Buy & hold assets .* Stack assets .* skipped/);
  expect(EXECUTION_COPY.stack.confirm).toMatch(/slices I set/);
});

test("a fund has no asset limit (docs#61)", () => {
  expect(B.builderLimits("demo")).toEqual({ assets: Infinity, positions: Infinity });
  expect(B.builderLimits("execution")).toEqual({ assets: Infinity, positions: Infinity });
  let state = B.emptyBuilder();
  const keys = B.ASSETS.filter((asset) => asset.category === "crypto" && B.canAdd(asset)).slice(0, 20).map((asset) => asset.key);
  for (const key of keys) state = B.addAsset(state, key, "demo");
  expect(B.assetKeys(state.rows).length).toBe(20);
  expect(B.positionsFull(state, "demo")).toBe(false);
  expect(B.problem(state, "demo")).not.toMatch(/at most|more than one fund can run/);
});

test("ZEC and the 8 added cryptos open on testnet only", () => {
  // 從主網的原始 status 開始（測試網的 build 載入時已經就地改過 B.ASSETS）。
  const copy = B.ASSETS.map((asset) => ({ ...asset, status: MAINNET_STATUS.get(asset.key) ?? asset.status }));
  expect(openTestnetCrypto(copy, false)).toEqual([]);
  const opened = openTestnetCrypto(copy, true);
  expect(opened.sort()).toEqual(["AAVE", "ATOM", "CAKE", "DOT", "FIL", "PEPE", "SHIB", "TON", "ZEC"]);
  const zec = copy.find((asset) => asset.key === "ZEC")!;
  expect(zec.status).toBe("ready");
  expect(B.canPickAsset(zec)).toBe(true);
  expect(B.playBlock("stack", zec, "demo")).toBeNull();
  expect(B.playBlock("stack", copy.find((asset) => asset.key === "CAKE")!, "demo")).toBeNull();
  // 第二次不再改；主網目錄（沒傳 copy 的那份）不動。
  expect(openTestnetCrypto(copy, true)).toEqual([]);
  expect(MAINNET_STATUS.get("ZEC")).toBe("no-feed");
  // 載入時只在測試網的 build 打開。
  expect(B.ASSET_BY_KEY.get("ZEC")?.status).toBe(IS_TESTNET ? "ready" : "no-feed");
});

// 原始碼守住：建立頁只送 typed 版本，要明示確認；連點與失敗重試不會建第二個策略。
test("the activation page publishes the typed version only after explicit confirmation", () => {
  const page = fs.readFileSync("src/features/create/CreateFundPage.tsx", "utf8");
  expect(page).toContain("typedVersionBody(");
  expect(page).toContain("publishVersion(token, strategy.id, version)");
  expect(page).not.toMatch(/kind: 'interval'|intervalSeconds/);
  expect(page).toMatch(/&& kindAgreed;/);
  expect(page).toContain("if (inFlight.current) return;");
  expect(page).toContain("createdStrategy.current?.name === trimmed");
  const api = fs.readFileSync("src/lib/api.ts", "utf8");
  expect(api).toContain("body: TypedVersionBody");
});

test("rebalancing: off, monthly or more than 5 points off, only when every asset is Buy & hold", () => {
  const rule = B.emptyBuilder().rules.rebalance;
  expect(rebalanceOf(rule)).toBe("none");
  expect(rebalanceOf({ ...rule, on: true, how: "schedule", every: "monthly" })).toBe("monthly");
  expect(rebalanceOf({ ...rule, on: true, how: "drift", drift: 5 })).toBe("drift");
  // 舊草稿的每季、其他門檻、等權重：不偷偷換成三個選項之一。
  expect(rebalanceOf({ ...rule, on: true, how: "schedule", every: "quarterly" })).toBeNull();
  expect(rebalanceOf({ ...rule, on: true, how: "drift", drift: 10 })).toBeNull();
  expect(rebalanceOf({ ...rule, on: true, how: "drift", drift: 5, weight: "equal" })).toBeNull();

  const holds = design(["hold", "hold"]);
  const monthly = { ...holds.rules, rebalance: { ...rule, on: true, how: "schedule" as const, every: "monthly" as const } };
  expect(designExecution(holds.rows, { rules: monthly, open: BOTH })).toEqual({ assets: new Map([["BTC", { kind: "hold" }], ["ETH", { kind: "hold" }]]), rebalance: "monthly" });
  expect(designExecution(design(["hold", "stack"]).rows, { rules: monthly, open: BOTH })).toEqual({ problem: { kind: "rebalance", reason: "stack" } });
  expect(describeExecutionProblem({ kind: "rebalance", reason: "stack" })).toMatch(/needs every asset on Buy & hold/);
  const quarterly = { ...holds.rules, rebalance: { ...rule, on: true, how: "schedule" as const, every: "quarterly" as const } };
  expect(designExecution(holds.rows, { rules: quarterly, open: BOTH })).toEqual({ problem: { kind: "rebalance", reason: "options" } });
  const draft = activationDesign({ ...holds, rules: monthly }, false, NOW)!;
  expect(draft.rebalance).toBe("monthly");

  const body = typedVersionBody({ chainId: 97, usdt: USDT, rebalance: "drift", assets: [{ address: BTC, weightBps: 10_000 }] });
  expect(body.execution.rebalance).toBe("drift");
  expect(typedVersionBody({ chainId: 97, usdt: USDT, assets: [{ address: BTC, weightBps: 10_000 }] }).execution.rebalance).toBe("none");
  expect(() => typedVersionBody({ chainId: 97, usdt: USDT, rebalance: "monthly", assets: [{ address: BTC, weightBps: 10_000, execution: { kind: "stack", every: "daily", weekday: null, timeUtc: "01:00", slices: 2 } }] })).toThrow("Buy & hold");
  expect(executionConfirm(new Set(["hold"]), "monthly")).toMatch(/once a month CRE8 sells and buys/);
  expect(executionConfirm(new Set(["hold"]), "drift")).toMatch(/more than 5 points off/);
  expect(executionConfirm(new Set(["hold"]), "none")).toBe(EXECUTION_COPY.hold.confirm);
});

test("the stack buys slider stops at 52 in every designer path", () => {
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(designer).not.toContain("B.LIMITS.stack.buys");
  expect(designer.match(/label="Number of buys" value=\{p\.buys\} limit=\{STACK_SLICES\}/g)?.length).toBe(2);
});
