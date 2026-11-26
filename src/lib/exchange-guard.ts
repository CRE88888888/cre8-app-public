/**
 * Privy 登入後換 CRE8 session（`POST /auth/privy`）的請求守衛（cre8-app#93）。純邏輯，不碰 React。
 *
 * 兩個問題：
 *   1. 請求一直 pending：以前只有一個 `inFlight` 旗標，25 秒的保護看到它就直接返回，登入永遠停在 exchanging，
 *      登出再登入也被舊請求擋住。→ 每次交換都有自己的 timeout（到時 abort），登出／重試時撤銷。
 *   2. A 的請求還沒回來就登出、改登入 B：A 稍後失敗，錯誤被寫進 B 的登入狀態。→ 每次交換有序號，
 *      成功、失敗、結束都先問 `isCurrent()`，不是現在這一次就丟掉。
 */
export type ExchangeTicket = {
  readonly seq: number;
  readonly userId: string;
  readonly signal: AbortSignal;
  /** 這一次還是不是「現在的」交換（沒被撤銷、沒有更新的一次）。 */
  isCurrent(): boolean;
  /** 結束（成功或失敗都要叫）：清掉 timeout。只對現在的這一次有作用。 */
  done(): void;
};

type Timers = {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const defaultTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createExchangeGuard(timeoutMs: number, timers: Timers = defaultTimers) {
  let seq = 0;
  let active: { seq: number; controller: AbortController; timer: unknown } | null = null;
  const cancel = (): void => {
    if (active === null) return;
    timers.clear(active.timer);
    active.controller.abort();
    active = null;
  };
  return {
    /** 有一次交換正在進行（還沒逾時、沒被撤銷）。 */
    busy: (): boolean => active !== null,
    /** 撤銷正在進行的那一次（登出、取消、重試時叫）。它之後回來的結果會被忽略。 */
    cancel,
    start(userId: string): ExchangeTicket {
      cancel();
      seq += 1;
      const mine = seq;
      const controller = new AbortController();
      // 到時只 abort：請求會以網路錯誤結束，走一般的失敗流程（畫面給「再試一次」）。
      const timer = timers.set(() => controller.abort(), timeoutMs);
      active = { seq: mine, controller, timer };
      return {
        seq: mine,
        userId,
        signal: controller.signal,
        isCurrent: () => active !== null && active.seq === mine,
        done: () => {
          if (active === null || active.seq !== mine) return;
          timers.clear(active.timer);
          active = null;
        },
      };
    },
  };
}
