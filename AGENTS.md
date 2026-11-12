# AGENTS.md — cre8-app

給 AI agent 與新工程師的工作規則。只寫從程式碼與文件查證過的事實；細節以 `README.md`、`docs/` 為準。

**開工前必讀：** 誰能在本 repo 工作、怎麼開 issue 與 PR、本機用哪些埠，一律以 [docs/AGENT_COLLABORATION](https://github.com/CRE8Finance/docs/blob/main/docs/AGENT_COLLABORATION.zh-TW.md) 為準（本機在 `~/Desktop/cre8-workspace/docs/docs/AGENT_COLLABORATION.zh-TW.md`）。只有擁有本 repo 的 lane 能開分支、commit、push；其他 lane 只能讀、執行、開 issue。

## 這個 repo 是什麼

CRE8 ATP 的前端：Vite 8 + React 19 + TypeScript（strict），Bun 管理套件。使用者在這裡瀏覽基金、SIWE 登入、建立策略、deposit / withdraw、續期 session key、觸發再平衡。

與其他 repo 的介面（只列已確認的）：
- **backend**：前端一律打相對路徑 `/api/*`（`src/lib/api.ts`，`VITE_API_BASE` 預設 `/api`）。dev 由 `vite.config.ts` proxy 到 `127.0.0.1:8081` 並剝掉 `/api`；部署的 Worker 在 A 段**不接任何後端**，`public/_worker.js` 對 `/api/*` 一律回 `503 PREVIEW_ONLY`。B 段接後端時，SIWE 要求後端 `AUTH_DOMAIN` 等於前端網域（見 `docs/deploy-cloudflare.md`）。
- **cre8-contracts**：前端沒有自己的位址表。smart account、executor、EntryPoint 位址由後端回應帶來（例如 `RenewalParams`），`src/lib/kernel.ts` 只接受 EntryPoint v0.7。後端位址來源是 `backend/src/addresses.ts`（見 `docs/architecture.md`）。
- **db**：前端不直接接觸，一律經過 backend。
- **cre8-landing**：本 repo 的 `public/landing/` 是首頁靜態檔，由 `_worker.js` 在 `/` 提供；與 cre8-landing repo 的同步方式未在程式碼中確認。

## 目錄地圖

```
src/lib/          api.ts（後端契約）、kernel.ts（ZeroDev Kernel / UserOp）、wallet*.ts、format.ts（BigInt 金額格式化）
src/features/     各頁面：vaults、fund、create、portfolios、strategy、studio、operator、reference
src/components/   共用元件；ui/ 是 shadcn 複製進來的原始碼
src/store/        zustand：session（sessionStorage）、wallet
src/styles/       本專案樣式；vendor/ 是從 bnb-agent-vaults 複製的設計稿 CSS
src/reference/    由 scripts/sync-public-ui.mjs 從釘住的來源 commit 同步的公開 UI 與資料
public/_worker.js Cloudflare Worker 入口（首頁 landing、/api 回 PREVIEW_ONLY）；設定在根目錄 wrangler.jsonc
tests/            bun test 單元測試
docs/             架構、使用者流程、部署、UI 接手規範（改 UI 前讀 docs/uiux-handoff.md）
```

視覺規格看根目錄 **`DESIGN.md`**，不要在別處重寫或另立規則。

## 常用指令（Bun 1.4.4，與 CI 一致）

```bash
bun install --frozen-lockfile   # 舊版 Bun（例如 1.3.x）讀不了 bun.lock
bun test tests                  # 不需環境變數
bun run typecheck               # tsc --noEmit
bun run build                   # tsc + vite build，讀 .env.production（已進版控）
bun run dev                     # http://localhost:5173；需要 backend 跑在 127.0.0.1:8081
```

沒有 lint script。dev 私鑰模式（只在 `import.meta.env.DEV` 出現）另需本機 anvil `127.0.0.1:8545`（走 `/rpc` proxy）。`demo.ts` 需要本機 backend。部署：merge 到 `main` 後由 Cloudflare Workers Builds 依 `wrangler.jsonc` 建置並部署到 Worker `cre8-app-migration-preview`（`https://cre8-app-migration-preview.example.workers.dev/`），**不用** GitHub Actions 或手動 `wrangler deploy`。A 段不綁 `cre8.finance` 底下任何網域；舊的 Pages 專案 `cre8-atp` 停止自動部署。本機確認用 `bunx wrangler dev`（見 `docs/deploy-cloudflare.md`）。

## 開 PR 前必跑（= `.github/workflows/ci.yml`）

1. `bun install --frozen-lockfile`
2. `bun test tests`
3. `bun run typecheck`
4. `bun run build`

請在**家目錄之外**的 checkout 驗證（例如 `/tmp`）：TypeScript 會往父目錄找 `~/node_modules`，本機能過、CI 會掛（`docs/uiux-handoff.md` §6.5）。

## 規則與地雷

- 改動只做被要求的部分，不順手重構。不確定就問，不要猜。
- Secret 不進版控：`.env`、`.env.*` 被忽略，只有 `.env.example` 與 `.env.production`（公開設定）進版控。所有 `VITE_*` 都會被寫進 bundle，**不要放任何憑證**。
- `VITE_CHAIN_ID` 是建置時常數：未設定時預設 1337（本機 fork），`.env.production` 設 56 = BSC 主網。換鏈要重新建置。
- 這支 app 會動主網真錢：會簽名、花 gas 或改鏈上權限的操作要先讓使用者看清楚再確認；金額一律 BigInt；讀不到狀態時顯示錯誤，不要顯示看似正常的 0。
- 版本固定：`@zerodev/sdk 5.5.11`、`@zerodev/ecdsa-validator 5.4.9` 必須與 backend 完全一致（不同會 AA24 簽章失敗）；viem 與後端同為 `2.57.x`。Bun 版本與 lockfile 一起升。
- session token 存 sessionStorage，provider 與私鑰不寫進任何儲存。
- `/api/bundler` 是認證端點，要帶 `Authorization: Bearer <token>`。
- `src/styles/vendor/` 與 `src/reference/` 是同步來源，不要手改；覆蓋寫在本專案自己的樣式。Tailwind 沒有 preflight，shadcn token 用 `sx-` 前綴。
- A 段 `/api/*` 只回 `PREVIEW_ONLY`，不要把它轉到任何後端（包括 Railway）。B 段接後端時改 `public/_worker.js`；換前端網域要同步改後端 `AUTH_DOMAIN` / `AUTH_URI`。
- `demo.ts` 內的私鑰是 Anvil 預設測試帳號，只能用於本機 fork，不要換成真私鑰。

## Commit / PR 慣例

- Commit 標題：繁體中文一句話，技術名詞保留英文並用反引號，例如「修 deposit 失敗：`.env.production` 補 VITE_RPC_URL」。
- 較大的改動在 body 用小標寫症狀、根因、做法，最後附驗證結果（例如 `typecheck 0 / build 4.46s / test 19 pass`）。
- PR 標題繁中，body 照 `.github/pull_request_template.md` 填寫；動到主網資金、對外 API 或部署要寫進「風險」。
