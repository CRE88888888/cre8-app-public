/**
 * 後端 waitlist 閘門（backend#134）：還沒放行（未加入、排隊中、撤銷）的人拿 CRE8 session 或用 session 呼叫 API，
 * 一律回 403 `WAITLIST_PENDING`。這不是一般錯誤：app 收到就清掉 session、重新問名單，讓 waitlist 閘門接手畫面。
 *
 * `lib/api.ts` 看到這個錯誤時發出事件；`WaitlistGate` 監聽。獨立成一個檔，避免 api.ts 與 waitlist 互相 import。
 */
export const WAITLIST_PENDING = 'WAITLIST_PENDING';
export const WAITLIST_PENDING_EVENT = 'cre8:waitlist-pending';

export function signalWaitlistPending(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new Event(WAITLIST_PENDING_EVENT));
}

/**
 * 名單變成放行（`WaitlistGate` 看到 approved 時發出）：PrivyRoot 之前換 session 被 403 WAITLIST_PENDING 擋下的話，
 * 收到這個事件就清掉那次失敗、重新換（#95 最後複審第 2 項）。
 */
export const WAITLIST_APPROVED_EVENT = 'cre8:waitlist-approved';

export function signalWaitlistApproved(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new Event(WAITLIST_APPROVED_EVENT));
}

/** 這個錯誤是不是 waitlist 閘門擋下的（403 WAITLIST_PENDING）。 */
export function isWaitlistPending(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 403 && (error as { code?: unknown }).code === WAITLIST_PENDING;
}

/** 放行後最多重換幾次 session（名單說 approved、換 session 卻還是 403 時，不會無限來回）。 */
export const APPROVAL_RETRIES = 2;

/** 收到「已放行」時要不要清掉上次的失敗、重新換 session：只有上次是被 WAITLIST_PENDING 擋下，而且還沒用完次數。 */
export function shouldRetryAfterApproval(failure: unknown, retriesSoFar: number): boolean {
  return isWaitlistPending(failure) && retriesSoFar < APPROVAL_RETRIES;
}
