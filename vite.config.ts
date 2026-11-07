import { defineConfig } from 'vite';

/**
 * 後端目前完全沒有 CORS 標頭（backend/src/server.ts 的 sendJson 只設 content-type 等），
 * 所以瀏覽器直接打 :8081 會被 preflight 擋掉。dev server 用 `/api` → backend 的 proxy，
 * 讓所有請求變成 same-origin。/api 這個前綴會在轉發前被剝掉。
 * 換後端位址：CRE8_BACKEND_URL=http://127.0.0.1:8080 bun run dev
 */
const backendTarget = process.env.CRE8_BACKEND_URL ?? 'http://127.0.0.1:8081';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
