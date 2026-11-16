# 前端部署：Cloudflare Worker `cre8-app-migration-preview`

```
https://cre8.finance、https://tst.cre8.finance（測試網站，chain 97；只有這兩個網址，*.workers.dev 與分支預覽網址關閉）
  ├── cre8.finance /             → waitlist；放行後轉到 https://tst.cre8.finance
  ├── cre8.finance 的 app 頁面    → 302 到 tst 同一路徑
  ├── /landing、/landing/*       → 302 到 /（舊 landing 不再對外）
  ├── /reference-data/demo-funds → 固定來源的公開資料（只讀）
  ├── /api、/api/*               → 後端（Worker 變數 API_ORIGIN，路徑原樣、保留 /api 前綴）；沒設時 503 PREVIEW_ONLY
  └── 其他                        → dist/ 的靜態檔，找不到時回 SPA 的 index.html（waitlist 閘門之後）
```

## 目前的部署目標：測試網

使用者 2026-11-16：只對外用 cre8.finance 與 tst.cre8.finance，兩個都由這個 Worker 提供，所有內容都在 waitlist 後面。

| 項目 | 值 |
|---|---|
| Worker 名稱 | `cre8-app-migration-preview` |
| 網址 | `https://cre8.finance`（waitlist）、`https://tst.cre8.finance`（app） |
| 自訂網域 | 在 Cloudflare dashboard 綁定（`wrangler.jsonc` 不設 `routes`；`workers_dev`、`preview_urls` 都是 false） |
| 正式建置的鏈 | **chain 97（BSC 測試網）**：`.env.production` |
| `/api/*` | 轉發到 `API_ORIGIN`；沒設時 `503 {"error":{"code":"PREVIEW_ONLY","message":"App preview"}}` |
| 舊的 Pages 專案 `cre8-atp`（`beta.cre8.finance`） | 關掉自動部署，停在舊版本 |

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

後端網址寫在 `wrangler.jsonc` 的 `"vars": { "API_ORIGIN": "…" }`（不是秘密，進版控；只寫 `https://主機`，不帶路徑）。
現在是 `https://website-production-d8e9f7cc.up.railway.app`（Railway 的 website 服務，總管 2026-11-17）。
空字串＝沒接後端，`/api` 回 PREVIEW_ONLY。換後端網址就改這一行、合併到 main，Workers Builds 部署時套用；
不用 dashboard 變數（部署會以 `wrangler.jsonc` 為準）。
`API_ORIGIN` 格式不對（http、帶路徑／查詢／帳密）時 `/api` 回 `503 API_MISCONFIGURED`，不會轉到別處。

### 測試網與主網的建置

`VITE_*` 是建置時常數，換鏈一定要重新建置。兩份設定都進版控、都是公開值，Cloudflare 不必設任何 `VITE_*`：

| 指令 | 讀哪個檔 | 鏈 | 用途 |
|---|---|---|---|
| `bun run build` | `.env.production` | 97（`VITE_RPC_URL=https://bsc-testnet.publicnode.com`） | 現在的正式建置（Workers Builds） |
| `bun run build:mainnet` | `.env.mainnet`（`vite build --mode mainnet`） | 56（`VITE_RPC_URL=https://bsc-rpc.publicnode.com`） | 之後主網上線時用；要不要把 Workers Builds 的 Build command 換成它，由使用者到時決定 |

兩個檔案除了 `VITE_CHAIN_ID`、`VITE_RPC_URL` 之外要保持一樣（`tests/testnet-launch.test.ts` 會檢查）。

### `/api` 轉發（`public/_worker.js` 的 `proxyApi`）

* 路徑原樣轉、保留 `/api` 前綴：`/api/waitlist/join?x` → `${API_ORIGIN}/api/waitlist/join?x`。
  `API_ORIGIN` 是 Railway 上對外的 website 服務，它自己剝掉 `/api` 再走私網轉給 API（總管 2026-11-17）。
* 轉過去的請求標頭只有 `Authorization`、`Content-Type`、`Accept`；**cookie 與其他標頭一律不轉**。
  `X-Forwarded-For` 由 Worker 用 Cloudflare 的 `CF-Connecting-IP` 設定，不用瀏覽器自己帶的。
  後端的限流只在來源 IP 列在 `RATE_LIMIT_TRUSTED_PROXY_IPS` 時才讀這個標頭（逐一列 IP，不收網段），沒列就以連線 IP 計；怎麼設由後端決定。
* method、查詢參數、body 原樣轉；不跟隨上游轉址（`redirect: manual`）；30 秒逾時回 `504 UPSTREAM_TIMEOUT`，
  連不上回 `502 UPSTREAM_UNAVAILABLE`。上游回應的狀態、body、標頭原樣回傳，只拿掉 `set-cookie`。
* 同源：前端與 API 都在 `tst.cre8.finance`，後端的 `CORS_ALLOWED_ORIGINS` 不用設。
  waitlist（`/api/waitlist/join`、`/api/operator/waitlist`）走同一個轉發。
* 後端上線時另外要做（不在這個 repo）：Privy 的 Allowed origins 加 `https://tst.cre8.finance`、`https://cre8.finance`。

### 合約地址簿（`src/lib/testnet-97.ts`）

由 `scripts/gen-testnet-97.mjs` 從 cre8-contracts 的 manifest 產生，**不要手改**。合約公開部署、拿到新 manifest 的 commit 後：

```bash
git -C ../cre8-contracts fetch origin
git -C ../cre8-contracts show <commit>:deployments/testnet-97.json > /tmp/testnet-97.json
node scripts/gen-testnet-97.mjs /tmp/testnet-97.json <commit>
bun test tests
```

用現在的 manifest（commit `6b9b6a45…`，`mode: "public"`）重跑會產生和版控裡一模一樣的檔案。送交易前 app 還會和後端
`/platform/status` 的 registry／executor 比對（`src/lib/address-book-check.ts`），對不上就不簽。

## 檔案

* `wrangler.jsonc` —— Worker 名稱、入口與靜態資源設定：
  * `main: public/_worker.js`：入口直接用原始碼。
  * `assets.directory: ./dist`：`bun run build` 的產物。
  * `assets.run_worker_first: true`：每個請求都先進 Worker（與以前 Pages 進階模式一致），
    否則 `/` 會直接拿到 `index.html` 而不是 landing。
  * `assets.not_found_handling: single-page-application`：`/funds/mag7` 這類 SPA 路徑回 `index.html`。
* `public/_worker.js` —— 路由規則（見上圖）。Vite 會把它複製進 `dist/`，
  所以 `public/.assetsignore` 把 `_worker.js` 排除在靜態資源之外，避免原始碼被當成公開檔案上傳。
* `VITE_API_BASE` 不用設：程式預設就是 `/api`。前端把 `PREVIEW_ONLY`、`UPSTREAM_*` 讀成一般的 `ApiError`。

## 本機確認

```bash
bun run build
bunx wrangler dev --port 8787     # 不需要登入；只在本機跑，不會部署
curl -s http://127.0.0.1:8787/api/health
# → {"error":{"code":"PREVIEW_ONLY","message":"App preview"}}（沒設 API_ORIGIN）
bunx wrangler dev --port 8787 --var API_ORIGIN:http://127.0.0.1:8081   # 本機後端
bunx wrangler deploy --dry-run    # 只打包檢查，不上傳
```

`wrangler dev` 會在 repo 裡產生 `.wrangler/`（已在 `.gitignore`）。

## CI（GitHub Actions，只有檢查、不部署）

| Workflow | 觸發 | 做什麼 |
|---|---|---|
| `.github/workflows/ci.yml` | PR、push main、手動 | `bun install --frozen-lockfile` → `bun test tests` → `typecheck` → `build` → 上傳 `dist` artifact |

Workers Builds 的建置失敗**只顯示在 Cloudflare**，PR 上看不到，所以 CI 保留：
`typecheck` 抓的是「本機能過、CI 掛掉」那類問題（例如依賴只存在於某人的家目錄 `~/node_modules`）。

* `--frozen-lockfile`：lockfile 與 `package.json` 不一致就**直接失敗**。
* 建置設定只來自 `.env.production`（chain 97），CI **不注入** `VITE_CHAIN_ID`，避免 CI 與本機產生不同 bundle。

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

## 換網域或換鏈時

* 前端與 API 要同源（見上面的轉發）；換前端網域時，後端的 SIWE `AUTH_DOMAIN`／`AUTH_URI` 與 Privy 的 Allowed origins 要跟著改。
* 換鏈 → 改用另一份 env 檔建置（`build` 或 `build:mainnet`），**並重新部署前端**（`VITE_CHAIN_ID` 是建置時常數）。

## 舊部署（凍結，僅供查證）

2026-11-12 以前，app 由 Cloudflare Pages 專案 `cre8-atp`（Git 整合，`dist/_worker.js` 進階模式）
部署到 `https://beta.cre8.finance`（備用 `https://cre8-atp.pages.dev`），`/api/*` 轉到 Railway 上的
v1 後端。A 段起這個專案關掉自動部署、停在當時的版本；Railway 與 `cre8.finance` 的處理見 ROADMAP
B 段與 A9 的盤點清單。
