/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API 的 base path。預設 `/api`（dev 由 vite proxy 轉到 127.0.0.1:8081）。 */
  readonly VITE_API_BASE?: string;
  /** 讀鏈用的 RPC。只在 dev 私鑰模式需要（錢包模式借錢包的 transport）。 */
  readonly VITE_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
