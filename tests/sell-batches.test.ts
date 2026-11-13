import { expect, test } from "bun:test";
import { MAX_SELL_BATCHES, SellBatchError, afterSellRun, formatRemainingUsd, runSellBatches, type SellBatch, type SellRun } from "../src/lib/sell-batches";

// 一輪續做之後該怎麼辦（cre8-app#44）：`remainingUsdE8: null` 是「不知道」，不可以當成完成。
test("what the caller does after a run: proceed, press again, or stop on an unknown remainder", () => {
  const run = (status: SellRun["status"], remainingUsdE8: bigint | null): SellRun => ({ status, batches: 1, steps: 1, remainingUsdE8, lastReason: "r" });
  // 賣完了。
  expect(afterSellRun(run("done", 0n))).toBe("proceed");
  // 到上限還有剩：再按一次。
  expect(afterSellRun(run("limit", 5_000_000_000n))).toBe("press-again");
  // 剩下的確定賣不動：往下做（提領轉出已有的、清倉把殘餘掃回）。
  expect(afterSellRun(run("stalled", 5_000_000_000n))).toBe("proceed");
  // 後端沒說還剩多少：停下，不轉出、不掃回。
  expect(afterSellRun(run("stalled", null))).toBe("unknown");
  expect(afterSellRun(run("limit", null))).toBe("unknown");
});

test("a batch that reports an unknown remainder never ends up as 'proceed'", async () => {
  for (const outcome of ["executed", "noop"] as const) {
    const result = await runSellBatches({
      first: async () => ({ outcome, reason: "規劃前被擋下", steps: [], remainingUsdE8: null }),
      next: async () => {
        throw new Error("must not continue with a guessed amount");
      },
    });
    expect(result.remainingUsdE8).toBeNull();
    expect(result.lastReason).toBe("規劃前被擋下");
    expect(afterSellRun(result)).toBe("unknown");
  }
});

const E8 = 100_000_000n;
const batch = (remaining: bigint | null | undefined, extra: Partial<SellBatch> = {}): SellBatch => ({
  outcome: "executed",
  reason: "ok",
  steps: [{}],
  ...(remaining === undefined ? {} : { remainingUsdE8: remaining === null ? null : remaining.toString() }),
  ...extra,
});

/** 依序回傳 `script` 裡的批次，並記下每一次續做帶進來的剩餘量。 */
function scripted(script: SellBatch[]) {
  const sent: (bigint | "first")[] = [];
  const progress: string[] = [];
  let index = 0;
  const take = () => {
    const value = script[index];
    index += 1;
    if (value === undefined) throw new Error("the loop asked for more batches than the script has");
    return value;
  };
  return {
    sent,
    progress,
    run: (maxBatches?: number) =>
      runSellBatches({
        first: async () => {
          sent.push("first");
          return take();
        },
        next: async (remaining) => {
          sent.push(remaining);
          return take();
        },
        ...(maxBatches === undefined ? {} : { maxBatches }),
        onContinue: ({ batch: k, remainingUsdE8 }) => progress.push(`batch ${k}, ${formatRemainingUsd(remainingUsdE8)} left`),
      }),
  };
}

test("stops at zero and feeds each remainder into the next batch", async () => {
  // backend#46 的例子：要賣 200，首批 150，剩 50 用 sellUsdE8 續做。
  const flow = scripted([batch(50n * E8), batch(0n)]);
  const run = await flow.run();
  expect(run).toEqual({ status: "done", batches: 2, steps: 2, remainingUsdE8: 0n, lastReason: "ok" });
  expect(flow.sent).toEqual(["first", 50n * E8]);
  expect(flow.progress).toEqual(["batch 2, $50.00 left"]);
});

test("a single batch that sells everything makes no further calls", async () => {
  const flow = scripted([batch(0n)]);
  expect((await flow.run()).status).toBe("done");
  expect(flow.sent).toEqual(["first"]);
  expect(flow.progress).toEqual([]);
});

test("an older backend without remainingUsdE8 is treated as one complete batch", async () => {
  const flow = scripted([batch(undefined)]);
  const run = await flow.run();
  expect(run.status).toBe("done");
  expect(run.batches).toBe(1);
});

test("stops at the batch limit with the remainder still known", async () => {
  // 每批賣 10，永遠賣不完：到上限就停。
  const script = Array.from({ length: 30 }, (_, index) => batch((1000n - 10n * BigInt(index + 1)) * E8));
  const flow = scripted(script);
  const run = await flow.run();
  expect(run.status).toBe("limit");
  expect(run.batches).toBe(MAX_SELL_BATCHES);
  expect(run.remainingUsdE8).toBe((1000n - 10n * BigInt(MAX_SELL_BATCHES)) * E8);
  expect(flow.sent.length).toBe(MAX_SELL_BATCHES);

  const short = scripted([batch(30n * E8), batch(20n * E8), batch(10n * E8)]);
  expect(await short.run(2)).toMatchObject({ status: "limit", batches: 2, remainingUsdE8: 20n * E8 });
});

test("a blocked, reverted or failed batch throws with what is left", async () => {
  for (const outcome of ["blocked", "reverted", "failed"] as const) {
    const flow = scripted([batch(80n * E8), batch(40n * E8), batch(null, { outcome, reason: "ExecutorPaused：全域暫停", steps: [] })]);
    let caught: unknown;
    try {
      await flow.run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SellBatchError);
    const error = caught as SellBatchError;
    expect(error.message).toBe("ExecutorPaused：全域暫停");
    expect(error.batches).toBe(3);
    expect(error.completedBatches).toBe(2);
    // 第三批沒成交：還剩的是送進去的 40。
    expect(error.remainingUsdE8).toBe(40n * E8);
  }
});

test("a first batch that is blocked before planning throws with an unknown remainder", async () => {
  const flow = scripted([batch(null, { outcome: "blocked", reason: "排程器沒有認領", steps: [] })]);
  await expect(flow.run()).rejects.toMatchObject({ name: "SellBatchError", completedBatches: 0, remainingUsdE8: null });
});

test("stops instead of looping when nothing more can be sold", async () => {
  // 這一批什麼都沒賣（noop）但還有剩。
  const noop = scripted([batch(50n * E8), batch(50n * E8, { outcome: "noop", reason: "nothing to sell", steps: [] })]);
  expect(await noop.run()).toMatchObject({ status: "stalled", batches: 2, remainingUsdE8: 50n * E8 });

  // 剩餘量沒有減少。
  const flat = scripted([batch(50n * E8), batch(50n * E8), batch(0n)]);
  expect(await flat.run()).toMatchObject({ status: "stalled", batches: 2 });

  // 成交了但不知道還剩多少：不能拿猜的數字去賣。
  const unknown = scripted([batch(null)]);
  expect(await unknown.run()).toMatchObject({ status: "stalled", batches: 1, remainingUsdE8: null });

  // 回來的不是數字。
  const garbage = scripted([{ outcome: "executed", reason: "ok", steps: [], remainingUsdE8: "abc" }]);
  expect((await garbage.run()).status).toBe("stalled");
});

test("a negative remainder counts as finished", async () => {
  const flow = scripted([batch(-5n)]);
  expect(await flow.run()).toMatchObject({ status: "done", remainingUsdE8: 0n });
});

test("remaining amounts format as dollars, truncated to cents", () => {
  expect(formatRemainingUsd(0n)).toBe("$0.00");
  expect(formatRemainingUsd(4_999_798_943n)).toBe("$49.99");
  expect(formatRemainingUsd(123_456_789_000_000n)).toBe("$1,234,567.89");
});
