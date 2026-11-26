/**
 * 帳戶處理中（409 PORTFOLIO_BUSY）時自動重送同一個請求（cre8-app#116）。
 *
 * 後端在帳戶正在處理時（例如剛加入基金）對 execution／buy-funding／funding-lots 回 PORTFOLIO_BUSY，
 * 要前端「用同一個請求再試」。第一次買入緊接在加入之後，每個新使用者都會撞到；原本畫面直接說 Purchase failed。
 * 現在每 3 秒重送一次，最多 60 秒，期間顯示「Setting up your account…」，超過才把錯誤丟出去。
 */
import { ApiError } from './api';

export const BUSY_RETRY_INTERVAL_MS = 3_000;
export const BUSY_RETRY_TIMEOUT_MS = 60_000;

export function isPortfolioBusy(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'PORTFOLIO_BUSY';
}

export async function retryWhileBusy<T>(
  run: () => Promise<T>,
  options: {
    /** 第一次撞到 BUSY 時呼叫（顯示「Setting up your account…」）。 */
    onBusy?: () => void;
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? BUSY_RETRY_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? BUSY_RETRY_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  let told = false;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      // 不是 BUSY，或再等一輪就超過上限：照原樣丟出去。
      if (!isPortfolioBusy(error) || now() - started + intervalMs > timeoutMs) throw error;
      if (!told) {
        told = true;
        options.onBusy?.();
      }
      await sleep(intervalMs);
    }
  }
}
