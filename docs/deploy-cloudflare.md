# 前端部署：Cloudflare Pages + `/api` 同源代理

```
app.cre8.xyz  ──┬── /            → Pages（靜態，dist/）
                └── /api/*       → Worker → https://api-production-7f13.up.railway.app（去掉 /api）
```

## 為什麼要同源（不是可選的優化）

後端有兩道「網域必須一致」的檢查：

1. **SIWE**（`auth.ts`）—— `message.domain` 必須逐字等於 `AUTH_DOMAIN`，否則登入直接被拒；
   而且錢包彈窗會顯示一個跟瀏覽器不同的網域 —— 那正是釣魚的特徵，使用者應該警覺。
2. **CORS**（`server.ts`）—— 只白名單 `CORS_ALLOWED_ORIGINS`（預設只有 vite dev 的 localhost）。

同源之後這兩件事都不需要處理：同源請求不會觸發 CORS，`AUTH_DOMAIN` 也自然等於使用者看到的網址。

## 檔案

* `public/_worker.js` —— Pages 進階模式的入口。Vite 會把 `public/` 原樣複製到 `dist/`，
  而 Pages 讀的就是 `dist/_worker.js`，所以不需要額外 build 設定。
* `VITE_API_BASE` 不用設：程式預設就是 `/api`。

## 建置

```bash
VITE_CHAIN_ID=56 \
VITE_RPC_URL=https://bsc-rpc.publicnode.com \
bun run build
```

`VITE_CHAIN_ID` 會在**建置時**被寫進 bundle（`uu=56`），不是執行時讀取 —— 換鏈就要重新建置。

## 部署（已實際執行）

```bash
wrangler pages project create cre8-atp --production-branch=main
wrangler pages deploy dist --project-name=cre8-atp --branch=main
```

沙箱環境要注意：wrangler 要寫 `~/Library/Preferences/.wrangler`，預設不可寫。
做法與 Railway CLI 相同 —— 把憑證複製到工作區並改 HOME：

```bash
mkdir -p .wrangler-home/Library/Preferences
cp -R ~/Library/Preferences/.wrangler .wrangler-home/Library/Preferences/
HOME=$PWD/.wrangler-home wrangler pages deploy dist --project-name=cre8-atp
```

（`.wrangler-home/` 含 OAuth token，已 gitignore。）

## 目前狀態（正式網域已上線）

| 項目 | 值 |
|---|---|
| 前端 | `https://beta.cre8.finance` |
| API（同源代理） | `https://beta.cre8.finance/api/*` |
| `AUTH_DOMAIN` | `beta.cre8.finance` |
| `AUTH_URI` | `https://beta.cre8.finance` |
| 備用 | `https://cre8-atp.pages.dev`（Pages 預設網域，永遠可用）|

### 為什麼不是 `app.cre8.finance`

那個子網域**已經被既有的 Vercel 生產站佔用**（`app.cre8.finance` → `a8596c55…vercel-dns-016.com`）。
搶過來等於弄壞正式站，所以用 `beta.`。

### 綁定步驟（實際做過的）

1. `POST /accounts/{account}/pages/projects/cre8-atp/domains {"name":"beta.cre8.finance"}`
   —— wrangler 4.157 **沒有** `pages domain` 子指令，只能走 API。
   狀態會停在 `pending`、驗證方式 `http`：**Cloudflare 不會自動在同一個 zone 建記錄**。
2. 在 `cre8.finance` 的 DNS 加一筆：
   ```
   CNAME  beta  →  cre8-atp.pages.dev   Proxied（橘雲）
   ```
3. 等 TLS 簽發（實測 < 1 分鐘，憑證是 zone 的萬用憑證 `CN=cre8.finance`）。
4. 後端 `AUTH_DOMAIN` / `AUTH_URI` 改成新網域並重新部署。

### 權限註記

wrangler 的 OAuth token 只有 **zone 讀取**，DNS 寫入會被拒（`error 10000 Authentication error`）。
所以「建立 DNS 記錄」這一步只能由使用者在 Dashboard 做，或改用帶 `dns_records:edit` 的 API token。

### 驗證（不需要登入）

```bash
curl -s https://beta.cre8.finance/api/health
curl -s -X POST https://beta.cre8.finance/api/auth/nonce   # domain 必須是新網域
```

### 換成 app.cre8.xyz 時要改三處

1. Cloudflare Pages → 專案 → Custom domains → 加 `app.cre8.xyz`（DNS 由 Cloudflare 自動建立）
2. Railway api 服務的 `AUTH_DOMAIN=app.cre8.xyz`、`AUTH_URI=https://app.cre8.xyz`，然後**重新部署**
3. 驗證：`curl -s -X POST https://app.cre8.xyz/api/auth/nonce` → domain 要是 `app.cre8.xyz`

**漏掉第 2 步的症狀**：頁面載入正常，但按下 Sign in 時錢包簽完卻得到
`SIWE message domain "app.cre8.xyz" does not match this server (cre8-atp.pages.dev)`。

驗證（不必登入就能看）：

```bash
curl -s -X POST https://api-production-7f13.up.railway.app/auth/nonce
# → {"domain":"app.cre8.xyz","chainId":56,"uri":"https://app.cre8.xyz",...}
```

**這一行就是整個設定的驗收條件**：domain 與 chainId 對了，SIWE 才會過。

## 要換環境時

* 換後端 → 改 `public/_worker.js` 的 `API_ORIGIN`
* 換前端網域 → 改 Railway 的 `AUTH_DOMAIN`/`AUTH_URI`，"並重新部署 api"
* 換鏈 → 改 `VITE_CHAIN_ID` **並重新建置前端**（它是建置時常數）

## 注意

`CORS_ALLOWED_ORIGINS` 刻意**不設** —— 同源不需要 CORS，而預設值只允許
`localhost:5173`（dev 用），生產環境不會有任何跨域來源被放行。這比「為了方便把 `*` 加進去」安全得多。
