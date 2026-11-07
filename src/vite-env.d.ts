/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API 的 base path。預設 `/api`（dev 由 vite proxy 轉到 127.0.0.1:8081）。 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
