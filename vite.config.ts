import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Dev proxy：前端一律打 `/api/...`，由 Vite 轉到後端。
 *
 * 這樣做的理由不是方便，是**同源**：後端只開了自己的 CORS 白名單，而 session token 走
 * `Authorization` 標頭 —— 用相對路徑就完全不必處理 CORS 與 preflight。
 * 部署時由反向代理做同一件事（`/api` → backend），前端不必改任何一行。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      /**
       * dev 私鑰模式專用：它沒有錢包 provider 可以借 transport，所以要有一個 RPC。
       * 這裡轉到本機 anvil；用真實錢包連線時**完全不會**用到這條路。
       */
      '/rpc': {
        target: 'http://127.0.0.1:8545',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rpc/, ''),
      },
    },
  },
});
