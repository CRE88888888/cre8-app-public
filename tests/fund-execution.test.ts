import { expect, test } from "bun:test";
import fs from "node:fs";
import { activationDesign } from "../src/lib/activation-design";
import { EXECUTION_COPY, describeExecutionProblem, designExecution, openKinds, rowExtras, typedVersionBody } from "../src/lib/fund-execution";
import * as B from "../src/reference/lib/fund-builder";

// cre8-app#79（APP-1）：一檔基金一種執行模式（hold／stack），送出 typed 版本；其他策略即將推出。

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const BTC = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";

const design = (plays: B.Play[]) => {
  let state = B.emptyBuilder();
  for (const [index, key] of ["BTC", "ETH", "SOL"].slice(0, plays.length).entries()) {
    state = B.addAsset(state, key, "demo");
    const row = state.rows[state.rows.length - 1]!;
    if (plays[index] !== "hold") state = B.setPlay(state, row.id, plays[index]!, "demo");
  }
  return { ...state, name: "Test fund" };
};

// stack 開放後（後端收創作者的定期參數）的行為；目前 stack 鎖著，見下一個測試。
const BOTH = ["hold", "stack"] as const;

test("all hold → hold, all stack → stack, nothing → hold", () => {
  expect(designExecution(design(["hold", "hold"]).rows, {}, undefined, BOTH)).toEqual({ kind: "hold" });
  expect(designExecution(design(["stack", "stack"]).rows, {}, undefined, BOTH)).toEqual({ kind: "stack" });
  expect(designExecution([], {}, undefined, BOTH)).toEqual({ kind: "hold" });
});

test("while stack is locked, a stack design is asked to switch to Buy & hold", () => {
  expect(openKinds()).toEqual(["hold"]);
  expect(openKinds(true)).toEqual(["hold", "stack"]);
  const result = designExecution(design(["stack"]).rows, {}, (play) => B.PLAYS[play as B.Play].name);
  expect(result).toEqual({ problem: { kind: "excluded", plays: ["Stack"] } });
  expect(describeExecutionProblem({ kind: "excluded", plays: ["Stack"] })).toBe("Stack is coming soon. Switch it to Buy & hold to activate this fund now.");
  expect(activationDesign(design(["stack"]))!.execution).toBeNull();
});

test("mixed hold and stack is not silently turned into one of them", () => {
  const result = designExecution(design(["hold", "stack"]).rows, {}, undefined, BOTH);
  expect(result).toEqual({ problem: { kind: "mixed" } });
  expect(describeExecutionProblem({ kind: "mixed" })).toContain("every asset");
});

test("the six excluded strategies are reported by name, before anything else", () => {
  const rows = design(["dips", "stack"]).rows;
  const result = designExecution(rows, {}, (play) => B.PLAYS[play as B.Play].name, BOTH);
  expect(result).toEqual({ problem: { kind: "excluded", plays: ["Buy dips"] } });
  expect(describeExecutionProblem({ kind: "excluded", plays: ["Buy dips", "Custom"] }, BOTH)).toBe("Buy dips, Custom are coming soon. Switch them to Buy & hold or Stack to activate this fund now.");
  for (const play of ["custom", "dips", "range", "trend", "lp", "carry"] as const) {
    const one = designExecution([{ play, p: B.defaults(play) } as B.Row], {}, undefined, BOTH);
    expect("problem" in one && one.problem.kind).toBe("excluded");
  }
});

test("old hold/stack extras and whole-fund rules block activation until turned off; the draft keeps its fields", () => {
  const lending = { play: "hold", p: { ...B.defaults("hold"), venue: "venus" } } as B.Row;
  const stops = { play: "stack", p: { ...B.defaults("stack"), exit: "tpsl" } } as unknown as B.Row;
  const ceiling = { play: "stack", p: { ...B.defaults("stack"), ceiling: 90_000 } } as B.Row;
  expect(rowExtras(lending)).toEqual(["Earn while held"]);
  expect(rowExtras(stops)).toEqual(["Take profit or stop loss"]);
  expect(rowExtras(ceiling)).toEqual(["Pause buying above a price"]);
  expect(designExecution([lending], {}, undefined, BOTH)).toEqual({ problem: { kind: "extras", settings: ["Earn while held"] } });
  // 整檔規則開著（例如舊草稿的再平衡）也要先關。
  expect(designExecution(design(["hold"]).rows, { rebalance: { on: true } })).toEqual({ problem: { kind: "extras", settings: ["Whole-fund rules"] } });
  expect(designExecution(design(["hold"]).rows, { rebalance: { on: false }, idle: { on: false } })).toEqual({ kind: "hold" });
  // 預設的 hold／stack 沒有附加設定。
  expect(rowExtras({ play: "hold", p: B.defaults("hold") } as B.Row)).toEqual([]);
  expect(rowExtras({ play: "stack", p: B.defaults("stack") } as B.Row)).toEqual([]);
  // 檢查不改動草稿。
  expect(lending.p).toEqual({ ...B.defaults("hold"), venue: "venus" });
});

test("the typed version keeps the mode, funding schedule and idle yield off", () => {
  const body = typedVersionBody({ chainId: 97, kind: "stack", usdt: USDT, assets: [{ address: BTC.toUpperCase().replace("0X", "0x"), weightBps: 5000 }, { address: USDT, weightBps: 5000 }], changeLog: "x" });
  expect(body).toEqual({
    chainId: 97,
    allocation: { assets: [{ address: BTC, weightBps: 5000 }, { address: USDT, weightBps: 5000 }] },
    execution: { kind: "stack" },
    schedule: { kind: "funding" },
    idleYield: { enabled: false },
    changeLog: "x",
  });
  // round-trip：JSON 來回後內容一樣（不丟模式）。
  expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  expect(typedVersionBody({ chainId: 56, kind: "hold", usdt: USDT, assets: [{ address: ETH, weightBps: 10_000 }] }).execution).toEqual({ kind: "hold" });
  expect("changeLog" in typedVersionBody({ chainId: 56, kind: "hold", usdt: USDT, assets: [{ address: ETH, weightBps: 10_000 }] })).toBe(false);
});

test("the typed version refuses weights that are not 100% and a stack with only USDT", () => {
  expect(() => typedVersionBody({ chainId: 97, kind: "hold", usdt: USDT, assets: [{ address: BTC, weightBps: 9_999 }] })).toThrow("99.99%");
  expect(() => typedVersionBody({ chainId: 97, kind: "hold", usdt: USDT, assets: [{ address: BTC, weightBps: 10_001 }] })).toThrow("100.01%");
  expect(() => typedVersionBody({ chainId: 97, kind: "hold", usdt: USDT, assets: [] })).toThrow();
  expect(() => typedVersionBody({ chainId: 97, kind: "stack", usdt: USDT, assets: [{ address: USDT.toUpperCase().replace("0X", "0x"), weightBps: 10_000 }] })).toThrow("Stack needs");
  // hold 可以是純 USDT。
  expect(typedVersionBody({ chainId: 97, kind: "hold", usdt: USDT, assets: [{ address: USDT, weightBps: 10_000 }] }).execution.kind).toBe("hold");
});

test("a design reaches the activation page with its mode, or with what to change", () => {
  const hold = activationDesign(design(["hold", "hold"]))!;
  expect(hold.execution).toBe("hold");
  expect(hold.executionProblem).toBeNull();
  // 目前 stack 鎖著：混合設計先被要求把 Stack 換成 Buy & hold。
  const mixed = activationDesign(design(["hold", "stack"]))!;
  expect(mixed.execution).toBeNull();
  expect(mixed.executionProblem).toBe(describeExecutionProblem({ kind: "excluded", plays: ["Stack"] }));
  // 權重照舊帶過去。
  expect(Object.values(mixed.weights).reduce((sum, value) => sum + value, 0)).toBe(100);
});

test("the copy names both modes and the confirmation states what will happen", () => {
  expect(EXECUTION_COPY.hold.confirm).toMatch(/does not sell or rebalance/);
  expect(EXECUTION_COPY.stack.confirm).toMatch(/skipped/);
  // 使用者決定：定期定額的參數由創作者設定，買的人只決定投多少。
  expect(EXECUTION_COPY.stack.line).toMatch(/Holders only choose how much/);
  expect(EXECUTION_COPY.stack.confirm).toMatch(/slices I set/);
});

// 原始碼守住：建立頁只送 typed 版本，不再送 interval；要明示確認；連點與失敗重試不會建第二個策略。
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
