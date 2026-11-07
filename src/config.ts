/**
 * 這個 harness 的所有可調參數集中在這裡。UI 上的輸入框會覆寫這些預設值，
 * 但任何一個值都可以只改這個檔案就換掉。
 */
export type AppConfig = {
  /** 後端 base URL（直連時用；預設 8081，因為後端可用 PORT 覆寫，其程式碼內的預設是 8080）。 */
  backendBaseUrl: string;
  /**
   * true = 所有 API 請求走 `/api`，由 Vite dev server proxy 到 backendBaseUrl。
   * 後端自己已經有 CORS（見 backend README §CORS），這只是 dev 時少一次跨 origin 的方便選項：
   * 關掉也一樣能用，relay 完全不依賴它。
   */
  useDevProxy: boolean;
  /** 鏈上 RPC（讀 nonce / gas price / receipt）。 */
  rpcUrl: string;
  /**
   * bundler relay 的路徑：UserOp 一律 `POST {backendBaseUrl}${bundlerRelayPath}` 由後端代送。
   *
   * 為什麼不直連 bundler：alto v1.2.5 沒有 CORS 支援（`--help` 沒有相關選項，`OPTIONS` 回 404 且
   * 不帶任何 `access-control-*`），瀏覽器直連一定被 preflight 擋掉——dev 與 production 都一樣。
   * 所以 `renewal-params.bundlerUrl` 只是資訊（顯示用），永遠不是 fetch 目標。
   */
  bundlerRelayPath: string;
  /** 預期 chainId；實際以 RPC 的 eth_chainId 為準（userOpHash 一定要用真實 chainId）。 */
  chainId: number;
  /** Kernel 版本字串（與 backend 對齊）。 */
  kernelVersion: string;
};

export const DEV_PROXY_PREFIX = '/api';

export const defaultConfig: AppConfig = {
  backendBaseUrl: 'http://127.0.0.1:8081',
  useDevProxy: true,
  rpcUrl: 'http://127.0.0.1:8545',
  bundlerRelayPath: '/bundler',
  chainId: 56,
  kernelVersion: '0.3.3',
};

/** 實際打出去的 base URL：開 proxy 時是 same-origin 的 `/api`。 */
export function effectiveBackendBaseUrl(cfg: AppConfig): string {
  if (cfg.useDevProxy) return DEV_PROXY_PREFIX;
  return cfg.backendBaseUrl.replace(/\/+$/, '');
}

/** bundler relay 的完整 URL。畫面上印的、實際 fetch 的都是這一個（不是 bundler 本人）。 */
export function bundlerRelayUrl(cfg: AppConfig): string {
  return `${effectiveBackendBaseUrl(cfg)}${cfg.bundlerRelayPath}`;
}
