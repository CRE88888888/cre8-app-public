/**
 * Privy 登入的設定（cre8-app#57）。這個檔案**不 import Privy SDK**：SDK 很大，只在有設定 App ID 時
 * 才由 `App.tsx` 動態載入（`features/auth/PrivyRoot.tsx`）。
 *
 * `VITE_PRIVY_APP_ID` 沒設（或是空字串）＝ 維持原本的錢包登入（EIP-6963／WalletConnect＋SIWE），
 * 畫面與行為完全不變。App ID 是公開值，但不寫死在 repo 裡，由部署環境提供。
 */
import { bsc, bscTestnet } from 'viem/chains';
import type { Chain } from 'viem';

export function readPrivyAppId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export const PRIVY_APP_ID = readPrivyAppId(import.meta.env.VITE_PRIVY_APP_ID);
export const PRIVY_ENABLED = PRIVY_APP_ID !== null;

/** Privy 視窗上顯示的登入方式。每一種都要在 Privy Dashboard 也打開才會出現。 */
export const PRIVY_LOGIN_METHODS = ['email', 'google', 'apple', 'wallet'] as const;

/** 嵌入式錢包在 `useWallet` store 裡用的 rdns（外部錢包用它自己的）。 */
export const PRIVY_EMBEDDED_RDNS = 'io.privy.wallet';

/**
 * Privy 的預設鏈：跟著 app 的 `VITE_CHAIN_ID`（與 `lib/kernel.ts` 的 `CHAIN_ID` 同一個來源）。
 * 56 → BSC 主網；97 → BSC 測試網（T 段）；其他（本機 fork 的 1337 等）→ 用 `rpcUrl` 組一條本機鏈。
 */
export function privyChain(chainId: number, rpcUrl?: string): Chain {
  const custom = rpcUrl !== undefined && /^https?:\/\//.test(rpcUrl) ? rpcUrl : null;
  const base: Chain | null = chainId === 56 ? bsc : chainId === 97 ? bscTestnet : null;
  if (base !== null) {
    return custom === null ? base : { ...base, rpcUrls: { ...base.rpcUrls, default: { http: [custom] } } };
  }
  return {
    id: chainId,
    name: `CRE8 Local (${chainId})`,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [custom ?? 'http://127.0.0.1:8545'] } },
  };
}
