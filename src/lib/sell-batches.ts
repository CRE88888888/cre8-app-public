/**
 * 分批賣出的續做迴圈（cre8-app#39）。純邏輯：不碰 React、不碰 fetch，呼叫端把「怎麼賣一批」傳進來。
 *
 * 背景（backend#40）：每個資產有單筆交易上限，大單會被切成好幾批。`/redeem` 與 `/close`
 * 每次只賣一批，回應裡的 `remainingUsdE8` 是還沒賣的名義額（美元，1e8 定點）：
 *   - 提領：首批送 `usd`，之後每批把上一批的 `remainingUsdE8` 帶回 `sellUsdE8`，直到 0。
 *   - 清倉：重複呼叫 `/close`，直到 0。
 * 每一次呼叫都是等那一批的交易確認後才回來，所以依序 await 就是「等上一批確認再送下一批」。
 *
 * 金額一律 BigInt。
 */

/** 連續最多賣幾批。到了就停下來請使用者再按一次，不讓一次點擊無限期跑下去。 */
export const MAX_SELL_BATCHES = 20;

export type SellBatch = {
  outcome: 'executed' | 'noop' | 'blocked' | 'reverted' | 'failed';
  reason: string;
  steps: readonly unknown[];
  /**
   * 還沒賣的名義額（E8 整數字串）。`"0"` = 賣完了；`null` = 後端在規劃前就被擋下，不知道還剩多少；
   * 欄位不存在 = 舊後端（沒有分批這回事），當成一批賣完。
   */
  remainingUsdE8?: string | null;
};

export type SellRun = {
  /**
   * - `done`    賣完了（剩 0）。
   * - `limit`   到了批數上限，還有剩；再按一次會從剩下的接續。
   * - `stalled` 還有剩，但再呼叫也賣不動（這一批什麼都沒賣、剩餘量沒有減少、或不知道剩多少）。
   */
  status: 'done' | 'limit' | 'stalled';
  /** 一共呼叫了幾批。 */
  batches: number;
  /** 實際送出的交易步數（各批 `steps` 的總和）。 */
  steps: number;
  /** 還沒賣的名義額；不知道時為 null。 */
  remainingUsdE8: bigint | null;
  lastReason: string;
};

/** 某一批被擋下、revert 或失敗。帶著「已經做了幾批、還剩多少」，讓呼叫端可以告訴使用者接下來怎麼辦。 */
export class SellBatchError extends Error {
  readonly batches: number;
  readonly completedBatches: number;
  readonly remainingUsdE8: bigint | null;
  constructor(message: string, info: { batches: number; completedBatches: number; remainingUsdE8: bigint | null }) {
    super(message);
    this.name = 'SellBatchError';
    this.batches = info.batches;
    this.completedBatches = info.completedBatches;
    this.remainingUsdE8 = info.remainingUsdE8;
  }
}

/**
 * 不是錯誤：賣到一半停下來（到了批數上限），還有剩。訊息直接給使用者看，請他再按一次。
 * 另外開一個類別，是為了讓畫面把它顯示成一般提示，而不是紅色的「Unexpected error」。
 */
export class SellUnfinished extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SellUnfinished';
  }
}

function parseRemaining(value: string | null | undefined): bigint | null {
  if (value === undefined) return 0n;
  if (value === null) return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return null;
  }
}

export async function runSellBatches(options: {
  /** 第一批（提領送 `usd`；清倉呼叫 `/close`）。 */
  first: () => Promise<SellBatch>;
  /** 之後的每一批，拿上一批回報的剩餘量去賣。 */
  next: (remainingUsdE8: bigint) => Promise<SellBatch>;
  maxBatches?: number;
  /** 要送第 `batch` 批之前呼叫（第一批不叫）：顯示「分批賣出中：第 k 批，剩約 $X」用。 */
  onContinue?: (info: { batch: number; remainingUsdE8: bigint }) => void;
}): Promise<SellRun> {
  const max = Math.max(1, options.maxBatches ?? MAX_SELL_BATCHES);
  let batches = 0;
  let steps = 0;
  let previous: bigint | null = null;
  let result = await options.first();
  while (true) {
    batches += 1;
    const remaining = parseRemaining(result.remainingUsdE8);
    if (result.outcome !== 'executed' && result.outcome !== 'noop') {
      throw new SellBatchError(result.reason, {
        batches,
        completedBatches: batches - 1,
        // 這一批沒成交：還剩的就是送進去的那個量（上一批回報的剩餘）。
        remainingUsdE8: previous ?? remaining,
      });
    }
    steps += result.steps.length;
    const status = sellStatus({ outcome: result.outcome, remaining, previous, batches, max });
    if (status !== null) {
      return { status, batches, steps, remainingUsdE8: remaining, lastReason: result.reason };
    }
    // `status === null` 代表可以繼續，那時 `remaining` 一定是正數。
    const carry = remaining as bigint;
    previous = carry;
    options.onContinue?.({ batch: batches + 1, remainingUsdE8: carry });
    result = await options.next(carry);
  }
}

/** 這一批之後該停在哪個狀態；`null` = 繼續賣下一批。 */
function sellStatus(input: {
  outcome: 'executed' | 'noop';
  remaining: bigint | null;
  previous: bigint | null;
  batches: number;
  max: number;
}): SellRun['status'] | null {
  if (input.remaining === 0n) return 'done';
  // 不知道還剩多少：不能拿一個猜的數字去賣。
  if (input.remaining === null) return 'stalled';
  // 這一批什麼都沒賣，或剩餘量沒有減少：再呼叫也一樣，停下來。
  if (input.outcome === 'noop') return 'stalled';
  if (input.previous !== null && input.remaining >= input.previous) return 'stalled';
  if (input.batches >= input.max) return 'limit';
  return null;
}

/** `4999798943n` → `"$49.99"`（美元 1e8 定點，截到分）。 */
export function formatRemainingUsd(remainingUsdE8: bigint): string {
  const cents = remainingUsdE8 / 1_000_000n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}.${(cents % 100n).toString().padStart(2, '0')}`;
}
