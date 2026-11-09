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

## 部署

```bash
# 首次
wrangler pages project create cre8-app --production-branch=main
wrangler pages deploy dist --project-name=cre8-app

# 自訂網域
wrangler pages domain add app.cre8.xyz --project-name=cre8-app
```

## 後端對應設定

```
AUTH_DOMAIN=app.cre8.xyz
AUTH_URI=https://app.cre8.xyz
```

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
