/**
 * A10 的純判斷（cre8-app#29）：暫停來源、版本差異、買入額度、錯誤訊息對照、首次存入前的鏈上核對。
 * 沒有 React、沒有 fetch、不碰鏈；金額一律 BigInt。
 */

export type PauseSource = 'safe' | 'operator' | 'account';

/** registry `pauseFlags` 的位元：1 = Safe、2 = 平台 operator、4 = 帳戶自己。 */
export function pauseSourcesFromFlags(flags: number): PauseSource[] {
  const sources: PauseSource[] = [];
  if ((flags & 1) !== 0) sources.push('safe');
  if ((flags & 2) !== 0) sources.push('operator');
  if ((flags & 4) !== 0) sources.push('account');
  return sources;
}

const SOURCE_LABEL: Record<PauseSource, string> = {
  safe: 'the security council (Safe)',
  operator: 'the platform operator',
  account: 'you',
};

/** 「誰暫停了這個帳戶」的一句話。來源不明（舊合約、讀不到）時不亂猜。 */
export function describePause(sources: readonly PauseSource[] | null): string {
  if (sources === null || sources.length === 0) return 'Trading for this account is paused.';
  const names = sources.map((source) => SOURCE_LABEL[source]);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Trading for this account was paused by ${list}.`;
}

/**
 * 恢復之前要不要先警告。
 *
 * 帳戶自己按「恢復」會把**所有來源**的暫停一起清掉。如果 Safe 或平台也暫停了它，
 * 那通常是有原因的（例如某個資產出事），不能讓使用者在不知情的情況下順手解掉。
 */
export function resumeNeedsWarning(sources: readonly PauseSource[] | null): boolean {
  return sources !== null && sources.some((source) => source !== 'account');
}

export type AllocationRow = { asset: string; weightBps: number };
export type VersionChange = {
  asset: string;
  fromBps: number;
  toBps: number;
  kind: 'added' | 'removed' | 'changed' | 'same';
};

/** 新舊兩版的資產與權重差異。先列有變動的（新增、移除、改權重），再列沒變的；各自依新權重由大到小。 */
export function diffAllocations(from: readonly AllocationRow[], to: readonly AllocationRow[]): VersionChange[] {
  const key = (asset: string): string => asset.toLowerCase();
  const before = new Map(from.map((row) => [key(row.asset), row]));
  const after = new Map(to.map((row) => [key(row.asset), row]));
  const rows: VersionChange[] = [];
  for (const row of to) {
    const old = before.get(key(row.asset));
    rows.push({
      asset: row.asset,
      fromBps: old?.weightBps ?? 0,
      toBps: row.weightBps,
      kind: old === undefined ? 'added' : old.weightBps === row.weightBps ? 'same' : 'changed',
    });
  }
  for (const row of from) {
    if (!after.has(key(row.asset))) rows.push({ asset: row.asset, fromBps: row.weightBps, toBps: 0, kind: 'removed' });
  }
  const rank = (row: VersionChange): number => (row.kind === 'same' ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || b.toBps - a.toBps || b.fromBps - a.fromBps);
}

/** 兩份配置是不是同一組資產與權重（順序不拘）。 */
export function sameAllocation(a: readonly AllocationRow[], b: readonly AllocationRow[]): boolean {
  return a.length === b.length && diffAllocations(a, b).every((row) => row.kind === 'same');
}

export type BuyAllowanceState = {
  /** true = 這個 24 小時窗口的買入額度用完了（賣出與提領不受影響）。 */
  exhausted: boolean;
  remaining: bigint;
  /** 額度用完時，下次可以買入的時間（unix 秒）；沒有開著的窗口時為 null。 */
  nextBuyAt: number | null;
};

/**
 * 買入額度還剩多少。
 *
 * 「用完」的門檻跟後端規劃器一致：它只排到 `cap × 98%`，所以已買的量到了那裡就再也排不進買入。
 * 窗口已經過期（`windowEndsAt <= now`）代表下一筆買入會開新窗口，不算用完。
 */
export function buyAllowanceState(
  allowance: { cap: bigint; bought: bigint; windowEndsAt: number },
  nowSeconds: number,
): BuyAllowanceState {
  const remaining = allowance.cap > allowance.bought ? allowance.cap - allowance.bought : 0n;
  const windowOpen = allowance.windowEndsAt > nowSeconds;
  const usable = (allowance.cap * 98n) / 100n;
  const exhausted = windowOpen && allowance.cap > 0n && allowance.bought >= usable;
  return { exhausted, remaining, nextBuyAt: exhausted ? allowance.windowEndsAt : null };
}

/** `1794614400` → `"14 Nov, 08:00"`（使用者的當地時間）。 */
export function formatNextBuy(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const PLATFORM_PAUSED_MESSAGE =
  'Trading is paused across the platform. Your funds stay in your own account, and you can withdraw them directly with your wallet at any time.';

export function buyLimitMessage(nextBuyAt: number | null): string {
  return nextBuyAt === null
    ? 'Today’s buy allowance is used up. Selling and withdrawing still work.'
    : `Today’s buy allowance is used up. Next buy time: ${formatNextBuy(nextBuyAt)}. Selling and withdrawing still work.`;
}

/**
 * 把 A10 的合約錯誤（或後端轉述它們的訊息）換成使用者看得懂的一句話；認不出來回 `null`。
 *
 * 對照表（cre8-contracts#10，X1 與 C2 共用）：
 * - `ExecutorPaused()`  → 平台暫停交易
 * - `Paused()`          → 你的帳戶已暫停（附來源）
 * - `BuyLimitExceeded`  → 額度用完與下次時間
 *
 * 後端沒有結構化的代碼，只有文字（`reason`），所以這裡比對字串。先比 `ExecutorPaused` 再比 `Paused`：
 * 後者是前者的子字串。
 */
export function explainA10Failure(
  message: string,
  context: { pauseSources?: readonly PauseSource[] | null; nextBuyAt?: number | null } = {},
): string | null {
  if (/ExecutorPaused|EXECUTOR_PAUSE|全域暫停/.test(message)) return PLATFORM_PAUSED_MESSAGE;
  if (/BuyLimitExceeded|BUY_ALLOWANCE|買入額度/.test(message)) return buyLimitMessage(context.nextBuyAt ?? windowEndFrom(message));
  if (/(^|[^A-Za-z])Paused\b(\(\))?/.test(message) || /帳戶.*暫停|已暫停/.test(message)) {
    return `${describePause(context.pauseSources ?? null)} Open My position to resume it.`;
  }
  return null;
}

/** 後端的額度訊息會帶 `windowEndsAt N`；抓得到就拿來顯示下次時間。 */
function windowEndFrom(message: string): number | null {
  const match = /windowEndsAt\s+(\d{9,11})/.exec(message);
  if (match === null) return null;
  const value = Number(match[1]);
  return value > 0 ? value : null;
}

export type EnrollmentCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 首次存入前的核對：鏈上實際 enroll 的策略與配置，是不是使用者在畫面上看到的這一檔。
 *
 * 為什麼要做：第一次 enroll 仍然是平台的 operator 送的（之後的升版才由使用者簽）。
 * 使用者把 USDT 轉進去之前，至少要確定帳戶被釘在他選的那個策略上，而不是別的。
 * 對不上就不轉錢。
 */
export function checkEnrollment(input: {
  expectedStrategyId: bigint;
  onchainStrategyId: bigint;
  onchainVersion: number;
  onchainAllocation: readonly AllocationRow[] | null;
  /** 後端記的同一版配置；拿不到就只核對策略 id。 */
  expectedAllocation: readonly AllocationRow[] | null;
}): EnrollmentCheck {
  if (input.onchainVersion === 0) {
    return { ok: false, reason: 'This account is not enrolled in any fund on-chain yet.' };
  }
  if (input.onchainStrategyId !== input.expectedStrategyId) {
    return {
      ok: false,
      reason: `This account is enrolled in fund #${input.onchainStrategyId} on-chain, not #${input.expectedStrategyId}.`,
    };
  }
  if (
    input.expectedAllocation !== null &&
    input.onchainAllocation !== null &&
    !sameAllocation(input.onchainAllocation, input.expectedAllocation)
  ) {
    return { ok: false, reason: 'The assets and weights enrolled on-chain do not match this fund.' };
  }
  return { ok: true };
}
