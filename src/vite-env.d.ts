/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 功能開關的覆寫，例如 `strategyDca=on,depositCard=soon`。名稱與預設值在 `lib/feature-flags.ts`；
   * 狀態是 `on`｜`mainnet`｜`soon`｜`later`。沒設就用預設值。
   */
  readonly VITE_FEATURES?: string;
  /** API 的 base path。預設 `/api`（dev 由 vite proxy 轉到 127.0.0.1:8081）。 */
  readonly VITE_API_BASE?: string;
  /** 讀鏈用的 RPC。只在 dev 私鑰模式需要（錢包模式借錢包的 transport）。 */
  readonly VITE_RPC_URL?: string;
  /** 真的開放存入／提領的基金 slug（逗號分隔）。其餘基金為 whitelist-only，見 `lib/live-funds.ts`。 */
  readonly VITE_LIVE_FUNDS?: string;
  /**
   * Privy 的 App ID（公開值）。有設 → 登入改用 Privy（email／Google／Apple／錢包）；
   * 沒設或空字串 → 維持原本的錢包登入。見 `lib/privy-config.ts`。
   */
  readonly VITE_PRIVY_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
