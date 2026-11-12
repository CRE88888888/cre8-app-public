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
 *   /                          → landing（`/landing/`）
 *   /reference-data/demo-funds → 固定來源的公開資料，只讀
 *   /api、/api/*               → 503 PREVIEW_ONLY
 *   其他                        → 靜態資源（`env.ASSETS`，找不到時回 SPA 的 index.html）
 */

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

    // 首頁是 landing（所有網域）。帶查詢參數的 `/?…` 仍交給 App：那是 Funds 的篩選深連結，
    // 已分享出去的連結不能因為首頁換成 landing 而失效。landing 的按鈕都連到 /vaults、/create、/funds/…。
    if (url.pathname === '/' && url.search === '' &&
        (request.method === 'GET' || request.method === 'HEAD')) {
      url.pathname = '/landing/';
      return env.ASSETS.fetch(new Request(url, request));
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
