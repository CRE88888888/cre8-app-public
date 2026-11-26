/**
 * 上次用哪一種方式登入。純邏輯。
 *
 * 為什麼要記：對使用者來說 Google 與 email 是同一件事（我的信箱），但對 Privy 是兩種登入方式——
 * 同一個信箱第一次用 Google、下次改用驗證碼，可能變成另一個帳號、另一個錢包。
 * 登入頁在上次用過的那一顆標「Last used」並把它當成主要按鈕，回來的人就不容易按錯。
 *
 * 按下去的當下先記成「待確認」（sessionStorage：Google／X 會整頁轉出去再回來，要撐過那一趟），
 * 真的登入成功才寫進 localStorage。按了但沒登入成功的不算。
 */
export type SignInChoice = 'google' | 'x' | 'email' | 'wallet';

export const LAST_SIGN_IN_KEY = 'cre8.lastSignIn';
export const PENDING_SIGN_IN_KEY = 'cre8.pendingSignIn';

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function choiceOf(value: unknown): SignInChoice | null {
  return value === 'google' || value === 'x' || value === 'email' || value === 'wallet' ? value : null;
}

export function lastSignIn(local: Reader | null): SignInChoice | null {
  try {
    return choiceOf(local?.getItem(LAST_SIGN_IN_KEY));
  } catch {
    return null;
  }
}

export function notePendingSignIn(session: Writer | null, choice: SignInChoice): void {
  try {
    session?.setItem(PENDING_SIGN_IN_KEY, choice);
  } catch {
    // storage 被擋：只是下次不會有「Last used」。
  }
}

/** 登入成功時呼叫：把待確認的那一種記成「上次用的」。沒有待確認的就不動。 */
export function confirmSignIn(session: Writer | null, local: Writer | null): SignInChoice | null {
  try {
    const pending = choiceOf(session?.getItem(PENDING_SIGN_IN_KEY));
    if (pending === null) return null;
    session?.removeItem(PENDING_SIGN_IN_KEY);
    local?.setItem(LAST_SIGN_IN_KEY, pending);
    return pending;
  } catch {
    return null;
  }
}
