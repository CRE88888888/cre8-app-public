/**
 * 一打開 app 就先看到登入頁（Privy 模式）。純邏輯。
 *
 * 使用者的要求：打開連結的第一個畫面是登入頁（像 fomo），不是要自己去找右上角的 Sign in。
 * 做法是把既有的登入頁（`components/SignInScreen.tsx`）在開場時自動打開，整頁顯示，並留一個
 * 「Browse first」讓人先逛——基金清單本來就不用登入也能看，分享出去的基金連結也要能直接看。
 *
 * 什麼時候打開：
 *   - 有設定 Privy（`VITE_PRIVY_APP_ID`）。沒設定時 app 是原本的連錢包登入，沒有這一頁。
 *   - 這個分頁還沒有 CRE8 session，也還沒跳過這一頁。
 *   - Privy 確定沒有人登入（`signed-out`）。SDK 還在載入時（`loading`）只有「這台裝置沒登入過」才先打開：
 *     新訪客一開就是登入頁；登入過的人多半 Privy 那邊還登入著，等 SDK 說了再決定，免得登入頁閃一下又消失。
 *   - 不是內部的營運後台（`/operator`）。
 */
import type { PrivyPhase } from '../store/privy';

export const ENTRY_SEEN_KEY = 'cre8.signInEntrySeen';

export type EntryInput = {
  /** 有沒有設定 Privy。 */
  enabled: boolean;
  phase: PrivyPhase;
  /** 這個分頁有還沒過期的 CRE8 session。 */
  sessionLive: boolean;
  /** 這個分頁已經跳過開場的登入頁。 */
  seen: boolean;
  /** 這台裝置以前用 Privy 登入過。 */
  returning: boolean;
  pathname: string;
};

export function shouldOpenEntry(input: EntryInput): boolean {
  if (!input.enabled || input.sessionLive || input.seen) return false;
  if (input.pathname === '/operator' || input.pathname.startsWith('/operator/')) return false;
  if (input.phase === 'signed-out') return true;
  return input.phase === 'loading' && !input.returning;
}

export function entrySeen(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(ENTRY_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markEntrySeen(storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(ENTRY_SEEN_KEY, '1');
  } catch {
    // storage 被擋：這一頁下次重新整理會再出現一次，不影響使用。
  }
}
