/**
 * 登入頁的小規則（純邏輯，`components/SignInScreen.tsx` 用）。
 */

/**
 * 寄出驗證碼之後要不要換到「輸入驗證碼」（cre8-app#93）。
 *
 * 只看**這一次**按 Send code 的結果：寄碼成功後按「Use another email」，SDK 仍停在 `awaiting-code-input`，
 * 以前的 effect 只看 SDK 狀態，會立刻把人跳回驗證碼頁，沒辦法換信箱。
 */
export function showCodeStep(input: { step: 'choose' | 'email' | 'code'; emailStep: string | null | undefined; requested: boolean }): boolean {
  return input.requested && input.step === 'email' && input.emailStep === 'awaiting-code-input';
}

/**
 * 對話框裡按 Tab／Shift+Tab 時，焦點要換到哪一個（把焦點留在對話框裡）。不需要攔就回 null。
 */
export function trapFocus<T>(focusables: readonly T[], active: T | null, backwards: boolean): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0] as T;
  const last = focusables[focusables.length - 1] as T;
  const index = active === null ? -1 : focusables.indexOf(active);
  if (index === -1) return backwards ? last : first;
  if (backwards && index === 0) return last;
  if (!backwards && index === focusables.length - 1) return first;
  return null;
}
