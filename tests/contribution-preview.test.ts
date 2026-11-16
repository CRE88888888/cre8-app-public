import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { ApiError, postPreviewContribution } from "../src/lib/api";
import {
  PREVIEW_BLOCK_COPY,
  PREVIEW_DEBOUNCE_MS,
  backendMinimum,
  designPreviewExecution,
  previewBody,
  previewBuys,
  previewFailure,
  previewScheduler,
  usdtToRaw,
  type PreviewState,
} from "../src/lib/contribution-preview";

const E18 = 10n ** 18n;
const raw = (usdt: number) => (BigInt(usdt) * E18).toString();

const execution = {
  kind: "per_asset",
  numeraire: "0xusdt",
  rebalance: "none",
  assets: [
    { asset: "0xusdt", weightBps: 1_000, yield: null },
    { asset: "0xbtc", weightBps: 6_000, execution: { kind: "stack", every: "weekly", weekday: 1, timeUtc: "01:00", slices: 12 }, yield: null },
    { asset: "0xeth", weightBps: 3_000, execution: { kind: "stack", every: "daily", weekday: null, timeUtc: "01:00", slices: 365 }, yield: null },
  ],
};
// 預覽的每期時間要在「現在」之後：測試的現在固定，不隨真實時鐘過期。
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const okResponse = {
  minimumRaw: raw(50),
  effectiveSlices: { "0xBTC": 12, "0xeth": 25 },
  slots: [{ at: "2026-11-17T01:00:00.000Z", budgetRaw: raw(62) }],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 手動計時器：debounce 的時間由測試決定。 */
function manualTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    timers: { set: (run: () => void, ms: number) => (pending.set(++next, { run, ms }), next), clear: (handle: unknown) => void pending.delete(handle as number) },
    pending,
    flush: () => {
      for (const [id, item] of [...pending]) {
        pending.delete(id);
        item.run();
      }
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the client posts chainId, execution and amountRaw to the public preview endpoint", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init };
    return new Response(JSON.stringify(okResponse), { status: 200 });
  }) as typeof fetch;
  const body = { chainId: 97, execution, amountRaw: raw(1_000) };
  expect(await postPreviewContribution(body)).toEqual(okResponse);
  expect(seen!.url).toBe("/api/strategies/preview-contribution");
  expect(seen!.init?.method).toBe("POST");
  expect(JSON.parse(String(seen!.init?.body))).toEqual(body);
  // 不需登入：不帶 authorization。
  expect((seen!.init?.headers as Record<string, string>).authorization).toBeUndefined();
});

test("success: the buyer sees the backend's slice counts without 'about'", async () => {
  const { timers, flush } = manualTimers();
  const states: PreviewState[] = [];
  const scheduler = previewScheduler((state) => states.push(state), { timers, send: async () => okResponse, now: () => NOW });
  scheduler.request(previewBody(97, execution, raw(1_000)));
  flush();
  await tick();
  const last = states.at(-1)!;
  expect(last.status).toBe("ok");
  // BTC 600 → 後端 12 期每期 50；ETH 300 → 後端 25 期每期 12（估計會是 30 期每期 10）。
  expect(previewBuys(execution, 1_000, last)).toEqual([
    { asset: "0xbtc", every: "weekly", slices: 12, buys: 12, perBuy: 50, about: false },
    { asset: "0xeth", every: "daily", slices: 365, buys: 25, perBuy: 12, about: false },
  ]);
});

test("422 codes block with a reason; every other failure falls back to the estimate marked 'about'", () => {
  for (const code of ["BELOW_MINIMUM_ALLOCATION", "PREVIEW_AMOUNT_TOO_LARGE", "BELOW_MIN_BATCH"] as const) {
    expect(previewFailure(new ApiError(422, code, "x"))).toEqual({ status: "blocked", code });
    expect(PREVIEW_BLOCK_COPY[code].length).toBeGreaterThan(0);
  }
  const fallbacks: [ApiError | Error, string][] = [
    [new ApiError(400, "INVALID_EXECUTION", "x"), "INVALID_EXECUTION"],
    [new ApiError(429, "RATE_LIMITED", "x"), "RATE_LIMITED"],
    [new ApiError(503, "PREVIEW_TIMEOUT", "x"), "PREVIEW_TIMEOUT"],
    [new ApiError(503, "PREVIEW_UNAVAILABLE", "x"), "PREVIEW_UNAVAILABLE"],
    [new ApiError(503, "MIN_FEE_UNAVAILABLE", "x"), "MIN_FEE_UNAVAILABLE"],
    [new ApiError(0, "NETWORK", "x"), "NETWORK"],
    [new Error("boom"), "NETWORK"],
  ];
  for (const [cause, code] of fallbacks) {
    const state = previewFailure(cause);
    expect(state).toEqual({ status: "fallback", code });
    expect(previewBuys(execution, 1_000, state).map((buy) => [buy.buys, buy.perBuy, buy.about])).toEqual([[12, 50, true], [30, 10, true]]);
  }
  expect(PREVIEW_BLOCK_COPY.BELOW_MIN_BATCH).toContain("10 USDT");
});

test("real HTTP errors map through the scheduler (429 with Retry-After, 503, 422)", async () => {
  const cases: [number, string, PreviewState["status"]][] = [
    [429, "RATE_LIMITED", "fallback"],
    [503, "PREVIEW_TIMEOUT", "fallback"],
    [422, "BELOW_MIN_BATCH", "blocked"],
    [422, "PREVIEW_AMOUNT_TOO_LARGE", "blocked"],
    [400, "INVALID_AMOUNT", "fallback"],
  ];
  for (const [status, code, expected] of cases) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code, message: "x" } }), { status, headers: { "retry-after": "1" } })) as typeof fetch;
    const { timers, flush } = manualTimers();
    const states: PreviewState[] = [];
    previewScheduler((state) => states.push(state), { timers, now: () => NOW }).request(previewBody(97, execution, raw(1_000)));
    flush();
    await tick();
    await tick();
    expect(states.at(-1)).toMatchObject({ status: expected, code });
  }
});

test("a malformed response falls back to the estimate instead of showing odd numbers", async () => {
  for (const bad of [{}, { ...okResponse, minimumRaw: "1.5" }, { ...okResponse, effectiveSlices: { "0xbtc": 0 } }, { ...okResponse, slots: [{ at: 1 }] }]) {
    const { timers, flush } = manualTimers();
    const states: PreviewState[] = [];
    previewScheduler((state) => states.push(state), { timers, send: async () => bad, now: () => NOW }).request(previewBody(97, execution, raw(1_000)));
    flush();
    await tick();
    expect(states.at(-1)).toEqual({ status: "fallback", code: "BAD_RESPONSE" });
  }
});

test("debounce: typing quickly sends one request (the last), 400ms after the last keystroke", async () => {
  const { timers, pending, flush } = manualTimers();
  const sent: string[] = [];
  const states: PreviewState[] = [];
  const scheduler = previewScheduler((state) => states.push(state), {
    now: () => NOW,
    timers,
    send: async (body) => (sent.push(body.amountRaw), okResponse),
  });
  for (const amount of ["1", "10", "100", "1000"]) scheduler.request(previewBody(97, execution, usdtToRaw(amount)));
  expect(PREVIEW_DEBOUNCE_MS).toBe(400);
  expect([...pending.values()].map((item) => item.ms)).toEqual([400]);
  expect(sent).toEqual([]);
  expect(states.at(-1)).toEqual({ status: "loading" });
  flush();
  await tick();
  expect(sent).toEqual([raw(1_000)]);
});

test("only the last request counts: the previous one is aborted and a late answer is ignored", async () => {
  const { timers, flush } = manualTimers();
  const signals: AbortSignal[] = [];
  const resolvers: ((value: unknown) => void)[] = [];
  const states: PreviewState[] = [];
  const scheduler = previewScheduler((state) => states.push(state), {
    now: () => NOW,
    timers,
    send: (_body, signal) => (signals.push(signal), new Promise((resolve) => resolvers.push(resolve))),
  });
  scheduler.request(previewBody(97, execution, raw(100)));
  flush();
  scheduler.request(previewBody(97, execution, raw(1_000)));
  flush();
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
  resolvers[1]!({ ...okResponse });
  await tick();
  resolvers[0]!({ ...okResponse, effectiveSlices: { "0xbtc": 1, "0xeth": 1 } });
  await tick();
  const last = states.at(-1)!;
  expect(last).toMatchObject({ status: "ok", amountRaw: raw(1_000) });
  // 清空（金額改成 0）回 idle，不送請求。
  scheduler.request(null);
  expect(states.at(-1)).toEqual({ status: "idle" });
});

test("chain 56 (or no stack, or no amount) never calls the endpoint", () => {
  expect(previewBody(56, execution, raw(1_000))).toBeNull();
  expect(previewBody(97, { ...execution, assets: [execution.assets[0], { asset: "0xbtc", weightBps: 9_000, execution: { kind: "hold" }, yield: null }] }, raw(1_000))).toBeNull();
  expect(previewBody(97, { kind: "target_weight" }, raw(1_000))).toBeNull();
  expect(previewBody(97, execution, usdtToRaw("0"))).toBeNull();
  expect(previewBody(97, execution, raw(1_000))).toEqual({ chainId: 97, execution, amountRaw: raw(1_000) });
  // 頁面用 build 的鏈（CHAIN_ID）決定，不寫死 97。
  expect(fs.readFileSync("src/features/fund/FundPage.tsx", "utf8")).toContain("useContributionPreview(previewBody(CHAIN_ID, execution, usdtToRaw(amountText)))");
  expect(fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8")).toContain('if (!IS_TESTNET || !rows.some((row) => row.play === "stack")) return null;');
});

test("amounts become 18-decimal raw strings", () => {
  expect(usdtToRaw("1000")).toBe(raw(1_000));
  expect(usdtToRaw("12.5")).toBe((125n * 10n ** 17n).toString());
  expect(usdtToRaw("59")).toBe(raw(59));
  expect(usdtToRaw("58.83")).toBe((5_883n * 10n ** 16n).toString());
  expect(usdtToRaw("1,000")).toBe(raw(1_000));
  expect(usdtToRaw("")).toBeNull();
  expect(usdtToRaw("abc")).toBeNull();
  expect(usdtToRaw("0")).toBeNull();
  // 審查 #95 第 10 項：不經 Number，59.9999999 不會變成 60；超過 18 位小數拒絕。
  expect(usdtToRaw("59.9999999")).toBe((599_999_999n * 10n ** 11n).toString());
  expect(usdtToRaw("0.000000000000000001")).toBe("1");
  expect(usdtToRaw("0.0000000000000000001")).toBeNull();
});

test("the backend minimum wins when it differs from the app's, and the designer asks again at that amount", () => {
  // 前端以為 58.83、後端回 59：顯示 59，用 59 再問一次；那一次回來之前期數用估計（about）。
  const mismatch: PreviewState = { status: "ok", amountRaw: (5_883n * 10n ** 16n).toString(), preview: { ...okResponse, minimumRaw: raw(59) } };
  expect(backendMinimum(mismatch, 58.83)).toEqual({ minimum: 59, retryRaw: raw(59), settled: false });
  const settled: PreviewState = { status: "ok", amountRaw: raw(59), preview: { ...okResponse, minimumRaw: raw(59) } };
  expect(backendMinimum(settled, 58.83)).toEqual({ minimum: 59, retryRaw: null, settled: true });
  // 後端比前端低也一樣以後端為準。
  expect(backendMinimum({ status: "ok", amountRaw: raw(100), preview: { ...okResponse, minimumRaw: raw(60) } }, 100)).toMatchObject({ minimum: 60, retryRaw: raw(60) });
  for (const state of [{ status: "loading" }, { status: "fallback", code: "RATE_LIMITED" }, { status: "blocked", code: "BELOW_MINIMUM_ALLOCATION" }] as PreviewState[]) {
    expect(backendMinimum(state, 58.83)).toEqual({ minimum: 58.83, retryRaw: null, settled: false });
  }
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(designer).toContain("const { minimum, retryRaw, settled } = backendMinimum(state, fallback);");
  expect(designer).toContain("if (retryRaw !== null && key !== null) setBackend({ key, raw: retryRaw });");
  expect(designer).toContain("const count = settled && state.status === \"ok\"");
});

test("the designer builds the same execution it would publish, with the full cash entry, from its rows", () => {
  const stack = { kind: "stack", every: "weekly", weekday: 1, timeUtc: "01:00", slices: 12 } as const;
  const assets = new Map<string, { kind: "hold" } | typeof stack>([["btc", stack], ["eth", { kind: "hold" }]]);
  const tokens: Record<string, string> = { btc: "0xBTC", eth: "0xETH" };
  const out = designPreviewExecution([{ key: "btc", share: 40 }, { key: "eth", share: 35.5 }], assets, (key) => tokens[key] ?? null, "0xUSDT");
  expect(out).toEqual({
    kind: "per_asset",
    numeraire: "0xusdt",
    rebalance: "none",
    assets: [
      { asset: "0xbtc", weightBps: 4_000, execution: stack, yield: null },
      { asset: "0xeth", weightBps: 3_550, execution: { kind: "hold" }, yield: null },
      { asset: "0xusdt", weightBps: 2_450, yield: null },
    ],
  });
  // 沒有測試網地址、或權重超過 100%：不預覽。
  expect(designPreviewExecution([{ key: "doge", share: 10 }], new Map([["doge", stack]]), () => null, "0xusdt")).toBeNull();
  expect(designPreviewExecution([{ key: "btc", share: 70 }, { key: "eth", share: 40 }], assets, (key) => tokens[key] ?? null, "0xusdt")).toBeNull();
});

test("buyer copy drops 'about' only for backend counts", () => {
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("{buy.about ? 'about ' : ''}{buy.buys} {buy.every}");
  expect(page).toContain("PREVIEW_BLOCK_COPY[state.code]");
  expect(page).not.toContain("stackBuys(");
});
