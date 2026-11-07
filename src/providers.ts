import type { EthereumProvider } from './wallet.js';

/**
 * EIP-6963（Multi Injected Provider Discovery）。
 *
 * 問題：`window.ethereum` 只會被「最後注入」的錢包佔用 —— 裝了 Phantom + MetaMask 時，
 * 先載入的那個被覆蓋，dApp 用它就可能連到不是使用者想選的錢包。這是生態的老問題，
 * 不是任何一個 app 的 bug。
 *
 * 解法：每個支援 6963 的錢包在載入時會 dispatch `eip6963:announceProvider`，
 * detail 帶 `{ info: { uuid, name, icon, rdns }, provider }`。dApp 監聽後自己列清單讓使用者選，
 * 完全不需要碰 `window.ethereum`。
 */

export type Eip6963ProviderInfo = { uuid: string; name: string; icon: string; rdns: string };
export type Eip6963ProviderDetail = { info: Eip6963ProviderInfo; provider: EthereumProvider };

type AnnounceDetail = { info: Eip6963ProviderInfo; provider: EthereumProvider };

/** 預設等待時間。錢包對 requestProvider 是同步回應的，300ms 足夠讓晚一步注入的錢包也趕上。 */
export const DEFAULT_DISCOVERY_WAIT_MS = 300;

/**
 * 收集目前已廣播的 provider。
 *
 * 先 dispatch `eip6963:requestProvider`（錢包收到後會補廣播一次，所以「比 dApp 早載入」的錢包
 * 也不會漏），再等 `waitMs` 收 announce，然後移除 listener 並 resolve。
 * 一個都沒廣播就回空陣列 —— 呼叫端會決定要不要退回 window.ethereum。
 */
export function discoverProviders(options?: { waitMs?: number }): Promise<Eip6963ProviderDetail[]> {
  const waitMs = options?.waitMs ?? DEFAULT_DISCOVERY_WAIT_MS;
  return new Promise((resolve) => {
    const found: Eip6963ProviderDetail[] = [];
    const seen = new Set<string>();
    const onAnnounce = (event: Event): void => {
      const detail = (event as CustomEvent<AnnounceDetail>).detail;
      if (!detail?.provider || !detail.info) return;
      // 去重：同一個錢包常會廣播多次（每個 frame / 重複注入各一次），以 rdns 判斷，保留第一次。
      const key = detail.info.rdns || detail.info.uuid;
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ info: detail.info, provider: detail.provider });
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      // 一定要移除：留著的話每次重新偵測都會再疊一個 listener，而且會捕捉到未來才出現的錢包。
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      resolve(found);
    }, waitMs);
  });
}

/**
 * `info.icon` 是 data URI，而且要直接塞進 `<img src>`。不是 `data:image/` 開頭的一律當成
 * 沒有圖示 —— 不要因為錢包自己說它是圖示就相信那個字串。
 */
export function safeIcon(icon: string | undefined): string | undefined {
  if (icon === undefined) return undefined;
  return icon.startsWith('data:image/') ? icon : undefined;
}

/**
 * 保底：`window.ethereum`。**只有 EIP-6963 一個錢包都沒廣播時才該用**，
 * 而且 UI 必須明確標示「不確定是哪個錢包」—— 它只屬於最後注入的錢包。
 */
export { fallbackInjectedProvider } from './wallet.js';
