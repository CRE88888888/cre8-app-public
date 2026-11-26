/**
 * Cloudflare Worker 入口（Worker `cre8-app-migration-preview`，設定在 `wrangler.jsonc`）。
 *
 * ## `/api/*`：轉發到後端（測試網上線，總管 2026-11-16）
 *
 * 後端網址由 Worker 變數 `API_ORIGIN` 決定（`wrangler.jsonc` 的 `vars`，預設空字串）。
 * **`API_ORIGIN` 是空的**時照舊回 `503 {"error":{"code":"PREVIEW_ONLY",...}}`，前端讀成 `ApiError`。
 * 轉發規則（`proxyApi`）：路徑原樣轉、**保留 `/api` 前綴**（後端在 Railway 由 website 服務對外，它自己剝掉 `/api`
 * 再走私網轉給 API；總管 2026-11-17），
 * 保留 method、查詢參數、body 與 `Authorization`／`Content-Type`／`Accept`／`Idempotency-Key`（My mix 建立重試用）；cookie 與其他標頭一律不轉；
 * `X-Forwarded-For` 由 Worker 用 Cloudflare 看到的來源 IP 設定（不信任瀏覽器自己帶的）；不跟隨上游轉址；
 * 30 秒逾時回 504；連不上回 502。上游回應的狀態與 body 原樣回傳，只拿掉 `set-cookie`。
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
 *   /api、/api/*               → 後端（`API_ORIGIN`）；沒設時 503 PREVIEW_ONLY
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

/** 沒接後端時 `/api/*` 的固定回應。格式與後端錯誤一致：`{ error: { code, message } }`。 */
function previewOnly() {
  return apiError(503, 'PREVIEW_ONLY', 'App preview');
}

function apiError(status, code, message) {
  return Response.json({error:{code,message}}, {status,headers:{'cache-control':'no-store'}});
}

/** 轉給後端的請求標頭：只有這幾個（cookie 與其他標頭不轉）。 */
const FORWARDED_HEADERS = ['authorization', 'content-type', 'accept', 'idempotency-key'];
/** 等後端多久（毫秒）。 */
const API_TIMEOUT_MS = 30_000;

/**
 * `API_ORIGIN` 只收 `https://主機[:埠]`（本機測試可用 http://127.0.0.1 或 localhost），不帶路徑、查詢、帳密。
 * 格式不對回 null（當成設定錯誤，不會轉到奇怪的地方）。
 */
function apiOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    const url = new URL(value.trim());
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** `/api/x?y` 原樣轉成後端的 `/api/x?y`（前綴由後端的 website 服務剝掉）。 */
async function proxyApi(request, origin, fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS) {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const client = request.headers.get('cf-connecting-ip');
  if (client) headers.set('x-forwarded-for', client);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let response;
  try {
    response = await fetchImpl(origin + url.pathname + url.search, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const timedOut = cause && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    return timedOut ? apiError(504, 'UPSTREAM_TIMEOUT', 'The server took too long to answer') : apiError(502, 'UPSTREAM_UNAVAILABLE', 'The server could not be reached');
  }
  const out = new Headers(response.headers);
  out.delete('set-cookie');
  return new Response(response.body, {status:response.status,statusText:response.statusText,headers:out});
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
    if (isApi) {
      const origin = apiOrigin(env.API_ORIGIN);
      if (origin === undefined) return previewOnly();
      if (origin === null) return apiError(503, 'API_MISCONFIGURED', 'The app is not connected to its server correctly');
      // `API_TIMEOUT_MS` 只給測試／營運調整；沒設用 30 秒。
      const timeout = Number(env.API_TIMEOUT_MS) > 0 ? Number(env.API_TIMEOUT_MS) : API_TIMEOUT_MS;
      return proxyApi(request, origin, fetch, timeout);
    }

    return env.ASSETS.fetch(request);
  },
};
