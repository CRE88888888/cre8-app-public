/**
 * Cloudflare Worker 入口（Worker `cre8-app-migration-preview`，設定在 `wrangler.jsonc`）。
 *
 * ## A 段（臨時網址）的規則
 *
 * 部署到 `https://cre8-app-migration-preview.example.workers.dev/`，**不接任何後端**：
 * `/api/*` 一律回 `503 {"error":{"code":"PREVIEW_ONLY",...}}`，不轉發到任何地方。
 * 前端 `src/lib/api.ts` 會把它讀成 `ApiError`，所以頁面照常顯示，需要後端的動作會顯示錯誤。
 * B 段接後端時再改這裡（見 `docs/deploy-cloudflare.md`）。
 *
 * ## 為什麼放在 `public/`
 *
 * 這支檔案以前是 Cloudflare Pages 進階模式的 `dist/_worker.js`。現在 Worker 的入口由
 * `wrangler.jsonc` 的 `main` 直接指向這裡；Vite 仍會把它複製進 `dist/`，所以
 * `public/.assetsignore` 把它排除在靜態資源之外，避免原始碼被當成公開檔案上傳。
 *
 * ## 路由規則（`run_worker_first`：每個請求都先進這裡）
 *
 *   cre8.finance、www  /        → App（waitlist 閘門；放行後由 App 轉到 https://tst.cre8.finance）
 *   cre8.finance、www  app 頁面 → 302 到 https://tst.cre8.finance 同一路徑（app 在 tst）
 *   其他網域          /        → App 首頁（waitlist 閘門之後是 Funds）
 *   /landing、/landing/*       → 302 到 `/`（使用者 2026-11-16：所有內容都在 waitlist 後面，不留 landing 入口）
 *   /reference-data/demo-funds → 固定來源的公開資料，只讀
 *   /api、/api/*               → 503 PREVIEW_ONLY
 *   其他                        → 靜態資源（`env.ASSETS`，找不到時回 SPA 的 index.html）
 */

/**
 * Waitlist（使用者 2026-11-16）：cre8.finance 打開就是 waitlist，放行後直接進 tst.cre8.finance 的 app。
 * 與 `src/lib/waitlist.ts` 的 LANDING_HOSTS／APP_ORIGIN 同值。
 */
const LANDING_HOSTS = ['cre8.finance', 'www.cre8.finance'];
const APP_ORIGIN = 'https://tst.cre8.finance';

/** app 的頁面（不是 landing、API、公開資料，也不是有副檔名的靜態檔）。 */
function isAppPage(pathname) {
  if (pathname === '/landing' || pathname.startsWith('/landing/')) return false;
  if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/reference-data/')) return false;
  const last = pathname.split('/').pop() ?? '';
  return !last.includes('.');
}

/** A 段 `/api/*` 的固定回應。格式與後端錯誤一致：`{ error: { code, message } }`。 */
function previewOnly() {
  return Response.json(
    {error:{code:'PREVIEW_ONLY',message:'App preview'}},
    {status:503,headers:{'cache-control':'no-store'}},
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 舊的 landing 靜態頁不再對外：任何網域的 /landing 都導回首頁（waitlist 閘門）。
    if (url.pathname === '/landing' || url.pathname.startsWith('/landing/')) return Response.redirect(url.origin + '/', 302);

    // landing 網域：首頁交給 App（waitlist 閘門），app 的頁面導到 tst（landing 的按鈕連到 /vaults、/create、/funds/…）。
    // 其他網域的首頁就是 App（不再改寫成 landing）。
    if (LANDING_HOSTS.includes(url.hostname.toLowerCase()) && (request.method === 'GET' || request.method === 'HEAD')) {
      const home = url.pathname === '/' && url.search === '';
      if (!home && isAppPage(url.pathname)) return Response.redirect(APP_ORIGIN + url.pathname + url.search, 302);
    }

    if (url.pathname === '/reference-data/demo-funds') {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status:405,headers:{Allow:'GET, HEAD'}});
      try {
        // Workers 不支援 redirect:error；手動拒絕轉址，避免固定資料來源變成外部跳轉。
        const response = await fetch('https://bnb-agent-vaults.vercel.app/api/demo-funds/', {method:request.method,headers:{Accept:'application/json'},redirect:'manual'});
        if (response.status >= 300 && response.status < 400) return Response.json({error:'Reference redirect refused'}, {status:502});
        const publicHeaders = new Headers(response.headers);
        publicHeaders.delete('set-cookie');
        publicHeaders.set('cache-control', 'public, max-age=60');
        return new Response(response.body, {status:response.status,headers:publicHeaders});
      } catch {
        return Response.json({error:'Reference temporarily unavailable'}, {status:503});
      }
    }

    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (isApi) return previewOnly();

    return env.ASSETS.fetch(request);
  },
};
