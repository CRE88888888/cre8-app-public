# 前端部署：Cloudflare Worker `cre8-app-migration-preview`

```
https://cre8.finance、https://tst.cre8.finance（只有這兩個網址，*.workers.dev 與分支預覽網址關閉）
  ├── cre8.finance /             → waitlist；放行後轉到 https://tst.cre8.finance
  ├── cre8.finance 的 app 頁面    → 302 到 tst 同一路徑
  ├── /landing、/landing/*       → 302 到 /（舊 landing 不再對外）
  ├── /reference-data/demo-funds → 固定來源的公開資料（只讀）
  ├── /api、/api/*               → 503 PREVIEW_ONLY（還沒接後端）
  └── 其他                        → dist/ 的靜態檔，找不到時回 SPA 的 index.html（waitlist 閘門之後）
```

## 目前的部署目標

使用者 2026-11-16：只對外用 cre8.finance 與 tst.cre8.finance，兩個都由這個 Worker 提供，所有內容都在 waitlist 後面。

| 項目 | 值 |
|---|---|
| Worker 名稱 | `cre8-app-migration-preview` |
| 網址 | `https://cre8.finance`（waitlist）、`https://tst.cre8.finance`（app） |
| 自訂網域 | 在 Cloudflare dashboard 綁定（`wrangler.jsonc` 不設 `routes`；`workers_dev`、`preview_urls` 都是 false） |
| `/api/*` | `503 {"error":{"code":"PREVIEW_ONLY","message":"App preview"}}` |
| 舊的 Pages 專案 `cre8-atp`（`beta.cre8.finance`） | 關掉自動部署，停在目前版本，A 段不再更新 |

## 部署路徑：Cloudflare Workers Builds（唯一一條）

merge 到 `main` → Cloudflare Workers Builds 自動建置並部署到 Worker `cre8-app-migration-preview`。
**不用** GitHub Actions 部署，也不在本機手動 `wrangler deploy`：兩條部署路徑會互相覆蓋，
「不確定哪個版本在線上」是最難查的狀態。

### Cloudflare 那邊的設定（使用者在 dashboard 做）

```
Workers & Pages → cre8-app-migration-preview → Settings → Build
  Git repository     CRE8Finance/cre8-app
  Production branch  main
  Build command      bun run build
  Deploy command     npx wrangler deploy
  Root directory     /                  （repo 根目錄就是 app）
  Build variable     BUN_VERSION = 1.4.4（與 CI、lockfile 一致）
```

`.env.production`（`VITE_CHAIN_ID=56`）**已進版控**，不需要在 Cloudflare 設任何 `VITE_*` 變數。

## 檔案

* `wrangler.jsonc` —— Worker 名稱、入口與靜態資源設定：
  * `main: public/_worker.js`：入口直接用原始碼。
  * `assets.directory: ./dist`：`bun run build` 的產物。
  * `assets.run_worker_first: true`：每個請求都先進 Worker（與以前 Pages 進階模式一致），
    否則 `/` 會直接拿到 `index.html` 而不是 landing。
  * `assets.not_found_handling: single-page-application`：`/funds/mag7` 這類 SPA 路徑回 `index.html`。
* `public/_worker.js` —— 路由規則（見上圖）。Vite 會把它複製進 `dist/`，
  所以 `public/.assetsignore` 把 `_worker.js` 排除在靜態資源之外，避免原始碼被當成公開檔案上傳。
* `VITE_API_BASE` 不用設：程式預設就是 `/api`。前端把 `PREVIEW_ONLY` 讀成一般的 `ApiError`。

## 本機確認

```bash
bun run build
bunx wrangler dev --port 8787     # 不需要登入；只在本機跑，不會部署
curl -s http://127.0.0.1:8787/api/health
# → {"error":{"code":"PREVIEW_ONLY","message":"App preview"}}
```

`wrangler dev` 會在 repo 裡產生 `.wrangler/`（已在 `.gitignore`）。

## CI（GitHub Actions，只有檢查、不部署）

| Workflow | 觸發 | 做什麼 |
|---|---|---|
| `.github/workflows/ci.yml` | PR、push main、手動 | `bun install --frozen-lockfile` → `bun test tests` → `typecheck` → `build` → 上傳 `dist` artifact |

Workers Builds 的建置失敗**只顯示在 Cloudflare**，PR 上看不到，所以 CI 保留：
`typecheck` 抓的是「本機能過、CI 掛掉」那類問題（例如依賴只存在於某人的家目錄 `~/node_modules`）。

* `--frozen-lockfile`：lockfile 與 `package.json` 不一致就**直接失敗**。
* 建置設定只來自 `.env.production`，CI **不注入** `VITE_CHAIN_ID`，避免 CI 與本機產生不同 bundle。

### 驗證 CI 會過（本機）

在家目錄之外的乾淨 checkout（例如 `/tmp`），使用 Bun 1.4.4：

```bash
bun install --frozen-lockfile
bun test tests
bun run typecheck
bun run build
```

僅更改 HOME 無法隔離 TypeScript 向父目錄搜尋 node_modules；必須讓原始碼本身位於家目錄之外。
詳細原因見 [uiux-handoff.md §6.5](uiux-handoff.md)。

## 公開資料的只讀代理

`GET /reference-data/demo-funds` 固定代理到來源站的公開歷史資料，僅允許 GET/HEAD，
不轉發錢包憑證、拒絕上游轉址。整合及驗收見 [public-ui-integration.md](public-ui-integration.md)。

## B 段接後端時（還沒做）

ROADMAP B 段第 6 步才接 `/api` 與 SIWE，要不要綁正式網域由使用者到時決定。屆時要注意：

* **前端與 API 要同源。** 後端有兩道「網域必須一致」的檢查：SIWE（`auth.ts`，`message.domain`
  必須逐字等於 `AUTH_DOMAIN`，錢包彈窗也會顯示網域）與 CORS（`server.ts` 只白名單
  `CORS_ALLOWED_ORIGINS`）。讓 Worker 把 `/api/*` 轉到後端（去掉 `/api` 前綴），兩件事都不用另外處理；
  `CORS_ALLOWED_ORIGINS` 刻意不設。
* 後端位址改 `public/_worker.js`，並更新 `tests/worker.test.ts`。
* 換前端網域 → 後端 `AUTH_DOMAIN` / `AUTH_URI` 改成新網域並重新部署。漏掉的症狀：頁面正常，
  錢包簽完 Sign in 卻得到 `SIWE message domain "…" does not match this server (…)`。
* 換鏈 → 改 `VITE_CHAIN_ID` **並重新建置前端**（它是建置時常數）。

## 舊部署（凍結，僅供查證）

2026-11-12 以前，app 由 Cloudflare Pages 專案 `cre8-atp`（Git 整合，`dist/_worker.js` 進階模式）
部署到 `https://beta.cre8.finance`（備用 `https://cre8-atp.pages.dev`），`/api/*` 轉到 Railway 上的
v1 後端。A 段起這個專案關掉自動部署、停在當時的版本；Railway 與 `cre8.finance` 的處理見 ROADMAP
B 段與 A9 的盤點清單。
