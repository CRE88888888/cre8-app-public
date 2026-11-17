/**
 * X／Google 登入轉回來的網址（cre8-app#107）。
 *
 * Privy（@privy-io/react-auth 3.51.3）每次載入頁面初始化時都會讀網址：只要還帶著 `privy_oauth_code`，
 * 而 localStorage 沒有 `privy:headless_oauth`，就當成 Privy 自己 UI 的 OAuth，打開它的 OAuthStatusScreen
 * 再兌換一次。我們用的是 headless 登入：第一次兌換成功後，`privy:code_verifier` 與 `privy:headless_oauth`
 * 都會被刪掉，所以帶著同一個 code 再載入（重新整理、另開分頁、回上一頁，或 Privy 清掉網址後 React Router
 * 又用舊的 search 把參數寫回去）時，一定顯示「Authentication failed」——登入其實已經成功。
 *
 * 判斷：網址有 code，但這個瀏覽器沒有 `privy:code_verifier`，這個 code 在這裡就已經不能兌換，
 * 直接把 `privy_oauth_*` 從網址拿掉。第一次正常轉回來（code_verifier 還在）完全不動。
 */
export const PRIVY_OAUTH_PARAMS = ['privy_oauth_code', 'privy_oauth_state', 'privy_oauth_provider'] as const;

/** Privy 開始 OAuth 時寫入、兌換成功後刪掉的 PKCE code verifier（localStorage，JSON 字串）。 */
export const PRIVY_CODE_VERIFIER_KEY = 'privy:code_verifier';

/** 網址上的 code 已經不能兌換時，回傳拿掉 `privy_oauth_*` 之後的路徑；其餘情況回 null（不動網址）。 */
export function deadOAuthCallbackPath(href: string, storage: Pick<Storage, 'getItem'> | null): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.searchParams.has('privy_oauth_code')) return null;
  let verifier: string | null = null;
  try {
    verifier = storage?.getItem(PRIVY_CODE_VERIFIER_KEY) ?? null;
  } catch {
    verifier = null; // 讀不到 localStorage：Privy 也讀不到，同樣兌換不了。
  }
  if (verifier !== null) return null;
  for (const key of PRIVY_OAUTH_PARAMS) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** 在 React Router 與 Privy 讀網址之前呼叫（`main.tsx`）。 */
export function dropDeadOAuthCallback(): void {
  if (typeof window === 'undefined') return;
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  const path = deadOAuthCallbackPath(window.location.href, storage);
  if (path !== null) window.history.replaceState(window.history.state, '', path);
}
