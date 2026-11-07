# cre8-app — session key 續期 handshake harness

最小可執行的前端，**唯一目的**是驗證 CRE8 的 session key 續期流程能不能從瀏覽器跑通：

```
錢包連線 → SIWE 簽章 → 拿 token → 列 portfolios → 抓 renewal-params
→ 組 UserOp（Kernel 0.3.3 / EntryPoint v0.7）→ personal_sign → 送後端 relay（POST /bundler）
→ userOpHash / transactionHash → 等 receipt → POST renewal-result
```

UI 之後會被既有 UI/UX 取代，所以這裡**刻意不做外觀**：一個頁面、幾顆按鈕、把每一步的原始值
印在 `<pre>` 裡。真正會被留下來的是「錢包 → 簽章 → 上鏈」這段 handshake 的寫法，集中在
`src/renewal.ts`。

## 怎麼跑

```bash
cd cre8-app
bun install
bun run dev          # http://127.0.0.1:5173
```

其他指令：

```bash
bun run typecheck    # tsc --noEmit
bun run build        # vite production build → dist/
bun run preview      # 用 dist/ 起一個靜態 server
```

### 後端要先起來

預設打 `http://127.0.0.1:8081`。**後端的程式碼預設值是 8080**，所以兩邊要對齊其中一邊：

```bash
# 後端用 8081（前端預設值）
cd backend && PORT=8081 bun run dev
# 或反過來：前端改用 8080
CRE8_BACKEND_URL=http://127.0.0.1:8080 bun run dev
```

`CRE8_BACKEND_URL` 是給 **Vite dev proxy** 用的（見下一節）；頁面上的「backend base URL」輸入框
則是關掉 proxy、直連時才生效。

### 為什麼預設走 Vite dev proxy（可關）

**後端有 CORS**（`backend/src/server.ts` 的 `applyCors`：`CORS_ALLOWED_ORIGINS` 的 origin 會拿到
`Access-Control-Allow-Origin`／`Allow-Credentials`，`OPTIONS` 回 204 並帶完整標頭）。所以
`http://127.0.0.1:8081` 從 `:5173` 直連是被允許的，proxy 只是 dev 時少一次跨 origin 的方便選項：

```
瀏覽器 → http://127.0.0.1:5173/api/auth/nonce → (proxy, 剝掉 /api) → http://127.0.0.1:8081/auth/nonce
```

把頁面上的 proxy 勾選取消就是直連路徑，一樣能用 —— **relay 不依賴 proxy**。

### 為什麼不能直連 bundler（alto v1.2.5 沒有 CORS）與 relay 的角色

這是這個 repo 最重要的一條限制：**瀏覽器永遠無法直連 alto**。

- alto **v1.2.5 完全沒有 CORS 支援**：`--help` 沒有任何相關選項，`OPTIONS` 請求回 404 且回應不帶
  任何 `access-control-*` 標頭。（v1.2.8 才有 `enable-cors` 設定，但它對 EntryPoint v0.7 的
  SafeValidator 是壞的，不能用。）
- 結果就是 `fetch('http://127.0.0.1:3001')` 一律失敗，錯誤長這樣：

  ```
  Access to fetch at 'http://127.0.0.1:3001/' from origin 'http://localhost:5173'
  has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header
  ```

- **這不是 dev 特有的問題 —— 生產環境一樣。** 所以「把 alto 對外開放」不是解法，任何環境都需要
  一個能回答 CORS 的代送者。

因此 UserOp 一律走後端 relay：

```
瀏覽器 → POST {backendBaseUrl}/bundler（Authorization: Bearer <token>, body = JSON-RPC 信封）
       → backend relay（方法白名單、原樣轉發）
       → http://127.0.0.1:3001（alto，只對後端開放：不進瀏覽器、不需要 CORS）
       → 上游的 status 與原始 bytes 原樣回傳（JSON-RPC 的 error 不被改寫）
```

- **alto 不需要對外**：它只需要被後端連得到（`BUNDLER_URL`，預設 `http://127.0.0.1:3001`）。
- `renewal-params.bundlerUrl` **只是資訊**（印在日誌裡），不是 fetch 目標；這裡已經沒有「直連
  bundler URL」這條路徑了。
- 契約、六個方法的白名單、錯誤碼（`BUNDLER_METHOD_NOT_ALLOWED` 403／`BUNDLER_UNAVAILABLE` 502）
  見 [`backend/README.md`](../backend/README.md) §bundler relay。

## 兩種錢包模式

### 模式 A · 瀏覽器注入錢包（真實路徑）

`discoverProviders()`（EIP-6963，見下一節）選出的 provider → `createWalletClient({ chain, account, transport: custom(provider) })`。
`window.ethereum` 只剩保底用途（§多錢包衝突與 EIP-6963）。

- **`account` 一定要帶**。`WalletClient` 沒有 `account` 時，ZeroDev SDK 會走 provider 分支自己再
  `eth_requestAccounts` 一次，行為不穩（多一次彈窗、或拿到不同帳號）。
- 簽章由錢包執行：SIWE 訊息與 UserOp 都是 `personal_sign`，使用者會在錢包裡看到 `localhost wants you to sign in…`。
- 這是唯一能碰真實資產的模式。

### 模式 B · dev 私鑰（本機用）

一個輸入框貼 anvil 私鑰 → `privateKeyToAccount(pk)` → 本地簽章。

- **只存在於 dev build，production 產物裡完全沒有**。整支模組是 `src/dev.ts`（含
  `privateKeyToAccount` 的 `viem/accounts` import、輸入框、「顯示 dev 模式（B）」按鈕），
  `src/main.ts` 把它包在 `DEV_WALLET_ENABLED` 裡用 `void import('./dev.js')` 動態載入。
  `vite build` 時 `import.meta.env.DEV` 是常數 `false`，Rollup 把整個分支判死，那個動態 import
  不會產生任何 chunk —— 所以是「不存在」，不是 `display:none`。驗證：
  `grep -r "privateKeyToAccount\|dev-private-key\|顯示 dev 模式" dist/assets/*.js` 應 0 命中。
- 面板預設**收合**，要按「顯示 dev 模式（B）」才展開（按鈕本身也是 dev build 才生成）。
- **不寫入 localStorage / sessionStorage / cookie**。金鑰只活在記憶體裡的 `LocalAccount` 物件；
  貼進輸入框後，按下連線就會立刻清空該欄位；重新整理頁面即消失。
- 標示寫在 UI 上，也寫在這裡：**只給本機 anvil fork 使用，絕不可用於真實資產。**

**雙重條件（第二道是保險，不是裝飾）**：

```ts
const DEV_WALLET_ENABLED =
  import.meta.env.DEV && /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(window.location.hostname);
```

⚠ **`vite build --mode development` 不是 production 產物**：那種 build 的 `import.meta.env.DEV`
是 `true`，私鑰輸入框會真的留在產物裡。這時擋住它的是 hostname 檢查 —— `DEV_WALLET_ENABLED`
為 false 就不 render（不建 DOM、不綁事件），部署到公開網域時那個面板連 HTML 都不會出現。
**要部署就一律用 `bun run build`（= `vite build`，不帶 `--mode`）。**

**為什麼 dev 模式只給本機用**：私鑰一旦進入瀏覽器執行環境，就等於暴露給頁面上的**任何**
JavaScript——包含第三方 script、瀏覽器擴充功能、XSS 注入的程式碼，以及任何能讀取記憶體的東西。
真實資產的簽章應該留在硬體錢包或瀏覽器擴充錢包的隔離環境裡（模式 A），永遠不要把它變成一個
可以被貼進網頁的 32 bytes 字串。這個模式存在的理由只有一個：本機 fork 上的測試金鑰是公開的
anvil 預設帳號，弄丟了也沒有價值，但換來的是「不用每次點錢包彈窗」的迭代速度。

## 錢包鏈 ≠ 設定的 chainId

實測（不是推測）：**Phantom 會拒簽 chainId 不符的 SIWE 訊息** ——

```
InvalidInputRpcError: Missing or invalid parameters.
Details: The app's signature request cannot be shown as the chain ID does not match the provided chain ID for verification.
```

MetaMask 不擋，但使用者是在一條自己沒在用的鏈上簽。所以「`personal_sign` 跟 chain 無關」
**只在 MetaMask 成立**，這個 app 不那樣寫、也不那樣假設。

連線後（以及每次 `chainChanged`）都用**連線時選定的那個 EIP-6963 provider** 讀 `eth_chainId`
（不是 `window.ethereum`，見下一節）：

- 不符 → 「1 · 連線」出現紅色提示（目前 / 預期 chainId **都用十進位**顯示）＋
  「切換錢包到 chainId N」按鈕；同時**「2 · SIWE 登入」與「4 · 續期」的按鈕 disabled**，
  按鈕旁寫明原因。簽章之前就處理掉，不讓使用者吃到看不懂的錢包錯誤。
- 切換走 `wallet_switchEthereumChain({ chainId: '0x38' })`（hex）。錢包回 **4902**
  （不認識這條鏈）→ 改用 `wallet_addEthereumChain`（`config.rpcUrl` / symbol BNB / decimals 18）
  加進去，**然後再切一次**（加入不等於切過去）。
- 使用者按「拒絕」→ 原文照印（`code 4001`），狀態標**已取消**，按鈕維持封鎖。
- 切換成功 → 重讀 `eth_chainId`、更新 UI、解除封鎖。
- 模式 B 沒有 provider，不參與這個判定（本地簽 EIP-191，沒有錢包鏈可切）。

## 多錢包衝突與 EIP-6963

### 為什麼 `window.ethereum` 會連到錯的錢包

瀏覽器只有**一個** `window.ethereum` 槽位，而每個注入錢包（MetaMask、Phantom、Rabby…）都往同一個
槽位寫。先載入的被後載入的覆蓋，所以 dApp 讀到的永遠是「最後注入」的那個 —— 使用者裝了
Phantom + MetaMask 時，點「連線注入錢包」跳出來的是 Phantom。這是整個生態的老問題，不是任何
一個 app 的 bug；也不可能靠讀 `window.ethereum.isMetaMask` 這類旗標可靠分辨（那些旗標自己也會
互相覆蓋）。

### EIP-6963 是什麼、我們怎麼用

**EIP-6963（Multi Injected Provider Discovery）** 讓錢包主動廣播自己：

```
錢包（載入時）  window.dispatchEvent(new CustomEvent('eip6963:announceProvider',
                  { detail: { info: { uuid, name, icon, rdns }, provider } }))
dApp（我們）    window.dispatchEvent(new Event('eip6963:requestProvider'))  // 請已載入的錢包補廣播
dApp（我們）    監聽 eip6963:announceProvider → 收集 → 以 info.rdns 去重 → 讓使用者選
```

實作在 `src/providers.ts`：

- `discoverProviders({ waitMs })`（預設 300ms）：先 dispatch `eip6963:requestProvider`，再收
  `eip6963:announceProvider`；**以 `info.rdns` 去重**（同一個錢包會因為重複注入／多個 frame 廣播
  多次，保留第一次）；時間到就 **removeEventListener** 之後才 resolve，不會累積 listener。
- 一個都沒廣播 → 回空陣列，由呼叫端決定要不要退回 `window.ethereum`。
- `safeIcon(icon)`：`info.icon` 是 data URI 而且會被塞進 `<img src>`，所以只接受 `data:image/`
  開頭，其餘一律當成沒有圖示。

UI 行為（`src/main.ts`）：

| EIP-6963 找到幾個 | 行為 |
|---|---|
| 0 個，也沒有 `window.ethereum` | 顯示「沒有偵測到任何瀏覽器錢包（模式 B 可以貼 anvil 私鑰代替）」 |
| 0 個，但 `window.ethereum` 存在 | 多一顆標明風險的保底按鈕「用 window.ethereum（不確定是哪個錢包）」 |
| 1 個 | 直接用它，不讓使用者多點一次 |
| 多個 | 展開按鈕列，一個錢包一顆（`info.name` + 合法的 `info.icon` 16×16 圖示），點哪個用哪個 |

連線後「目前地址」顯示成 `0x90F7… (MetaMask)` —— 括號裡的名字來自 `info.name`。走保底路徑時沒有
名字可顯示，日誌會多印一行警告。

「重新偵測錢包」按鈕會重跑一次 `discoverProviders()`：錢包剛解鎖或剛安裝完時，按它就夠，不必重新
整理頁面。

### 錢包沒出現在清單裡怎麼辦

代表那個錢包**沒有廣播 EIP-6963**，通常是版本太舊：

- MetaMask 需要 **v11 以上**；更舊的版本只會寫 `window.ethereum`（而且 `isMetaMask` 也可能被
  別的錢包覆蓋）。
- Phantom 需要 **v23 以上**（它的 rdns 是 `app.phantom`）。
- 判斷方式：在 DevTools console 貼下面這段，看清單裡有哪些 `rdns` 回應 —— 沒有你的錢包，就是它
  不支援 6963，只能升級它；否則就只能走「6963 完全沒有廣播時」才出現的保底按鈕（那條路徑連到
  哪個錢包取決於誰最後注入，UI 上已明確標示風險）。

  ```js
  window.addEventListener('eip6963:announceProvider', (e) =>
    console.log(e.detail.info.name, e.detail.info.rdns));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  ```

常見 rdns：`io.metamask`（MetaMask）、`app.phantom`（Phantom）、`io.rabby`（Rabby）、
`com.coinbase.wallet`（Coinbase Wallet）、`me.rainbow`（Rainbow）。

## 設定

集中在 `src/config.ts`，頁面上也有對應輸入框（改輸入框不會持久化）：

| 設定 | 預設 | 說明 |
|---|---|---|
| `backendBaseUrl` | `http://127.0.0.1:8081` | 直連時的後端位址 |
| `useDevProxy` | `true` | 走 `/api` → Vite proxy；dev 方便用，後端本身有 CORS，關掉也能直連 |
| `rpcUrl` | `http://127.0.0.1:8545` | 讀 chainId / nonce / gas price / receipt |
| `bundlerRelayPath` | `'/bundler'` | UserOp 的 JSON-RPC 一律 `POST {base}${bundlerRelayPath}`；不直連 bundler |
| `chainId` | `56` | 預期值；**實際以 RPC 的 `eth_chainId` 為準** |
| `kernelVersion` | `0.3.3` | 與 backend 對齊 |

Token 與私鑰都只存在記憶體，重新整理就要重登 —— 測試工具不需要持久化，少一個洩漏面。

## 實作重點（為什麼這樣寫）

- **EntryPoint 版本由位址決定**（`src/renewal.ts: entryPointFromAddress`）。backend 用的是
  canonical **v0.7**（`0x0000…da032`，見 `backend/src/addresses.ts`），不是 v0.6。版本猜錯，
  整包 gas 與 hash 都會錯。
- **chainId 用 RPC 實際值**。`getUserOperationHash` 的 domain separator 含 chainId，
  而 `signerToEcdsaValidator` 是在建立 validator 時 `getChainId(client)` 把 chainId 綁進閉包的
  （`@zerodev/ecdsa-validator/_esm/toECDSAValidatorPlugin.js:19`）。anvil fork 的 chainId 常是
  `31337` 而非 `56`，用錯就是上鏈後 `AA24 signature error`。
- **`createKernelAccount` 必須傳 `address: accountAddress`** 短路推導；重算 counterfactual 需要
  當初的 initConfig，前端沒有。
- **UserOperation 走手寫 bundler JSON-RPC**（`src/renewal.ts: bundlerRpc`），不用 `permissionless`
  的 `createSmartAccountClient`：這個 harness 的價值就在於把 `eth_estimateUserOperationGas` 的原始
  回應、`userOpHash`、gas 欄位全部印出來，SDK 的送出路徑會把這些吃掉。傳輸層是後端的
  `POST /bundler` relay（`BundlerRelay = {baseUrl, path, token}`），**不是** bundler 本人。
- **personal_sign 發生的位置**：`kernel.signUserOperation()` → `kernelPluginManager` →
  `@zerodev/ecdsa-validator` 的 `signUserOperation()`，它對 `getUserOperationHash()` 的結果呼叫
  viem `signMessage(client, { account, message: { raw: hash } })`，也就是 EIP-191
  （`\x19Ethereum Signed Message:\n32` 前綴）。這就是 Kernel 的驗證模式 B，也是這個 app 要驗證的東西。

## 頁面上會看到什麼

每一步都有狀態（進行中 / 成功 / 失敗），失敗時印**原始錯誤**（含後端 `{ error: { code, message } }`
與 raw body、relay 原樣透傳的 bundler JSON-RPC `error`），不吞成「發生錯誤」。中間值全部印出：`userOpHash`、
`transactionHash`、`permissionId`、`sessionKeyAddress`、`keyRef`、`validUntil`、gas 估算值、
`callData`、`nonce`、`signature`、`policySnapshot`。

## 版本

刻意與 `backend/package.json` 對齊，避免 ZeroDev 行為漂移：

- `@zerodev/sdk` 5.5.11
- `@zerodev/ecdsa-validator` 5.4.9
- `viem` 2.57.16

沒有引入 CSS/UI framework。`permissionless` 沒有裝 —— 因為送 op 走直接 JSON-RPC。

## 投組狀態與再平衡（operator 面板）

「3 · Portfolios」每列有兩個按鈕：

| 按鈕 | 行為 |
|---|---|
| **續期** | 換 session key（`GET /portfolios/:id/renewal-params` → 簽名 → 上鏈 → `POST .../renewal-result`） |
| **看狀態** | `GET /portfolios/:id/status` → 在該列下方展開漂移表、blocked 原因、block 快照 |

### 「看狀態」顯示什麼

```
投組狀態 · portfolio #305  [完整]
block #132174703 · account 0xb008dcff…
總價值 $511,338.07   complete true
gross drift 2008 bps ／ 門檻 100 bps ／ 需要再平衡：是

symbol   目標 bps  現況 bps     差額        USD 價值
WBNB        3334      3333      -1 bps    $170,448.59
NVDAB       3333      1326   -2007 bps     $67,816.29
USDT        3333      5340   +2007 bps    $273,073.18
```

⚠ **狀態讀取失敗時（503）不會顯示任何漂移數字** —— 面板會明說「這是讀不到狀態，不是漂移 0、不需要再平衡」。這一點是刻意的：一個看起來正常的「0 漂移」比一個錯誤訊息危險得多。

### 「觸發再平衡」

條件：`drift.needsRebalance === true` **且** `blocked` 是空的。

按下去**不會立刻送交易**，會先出現確認框，列出會發生什麼、以及**它不知道什麼**（實際的 swap 參數由後端規劃）。只有按「確認執行」才會 `POST /portfolios/:id/rebalance`。

### ⚠ 這支端點預設是關的

`POST /portfolios/:id/rebalance` 預設回 **403 `OPERATOR_REBALANCE_DISABLED`**。

要在後端啟動時帶上：

```bash
ENABLE_OPERATOR_REBALANCE=true bun src/index.ts
```

**理由**：這是一個「用 HTTP POST 就能讓伺服器用 session key 動錢」的端點。生產環境可能永遠不該開它 —— 那時排程器自己跑，不需要人工觸發。預設 fail-closed，要開得明確。

app 對這個 403 有專門的顯示（不是一般錯誤），會告訴你需要哪個環境變數。

### 純函式層可獨立測

所有文字格式化都在 `src/status-format.ts`（無 DOM、無 fetch、runtime 零 import），所以可以不開瀏覽器直接驗：

```bash
bun -e 'const m = await import("./src/status-format.ts"); console.log(m.statusFailureLines({status:503, code:"X", message:"y", raw:""}))'
```

## 兩個容易誤讀的欄位

### `actualGasUsed`（不是鏈上 `tx.gasUsed`）

結果卡上的 gas 欄位叫 **`actualGasUsed`**，它是 `UserOperationEvent.actualGasUsed`：

```
actualGasUsed = 真實 EVM gas + preVerificationGas（calldata 的固定費率成本）
```

所以它**會大於**區塊瀏覽器上的 `tx.gasUsed`（實測：857,487 vs 694,521，差額就是 calldata 成本）。兩者都對，但不該相等 —— 標籤刻意寫成 `actualGasUsed` 就是為了避免這個誤讀。

### `sessionKey.configured` vs `sessionKey.usable`

`GET /portfolios/:id/status` 回兩個不同的東西：

| 欄位 | 意思 |
|---|---|
| `configured` | DB 記的最新那把（就是 `GET /portfolios` 顯示的）。**可能沒安裝在鏈上** |
| `usable` | 排程器實際會用的那把（由新到舊逐把驗 `permissionConfig().signer != 0`） |

實例（本機 dev）：

```
#5    configured 0x7db20115 (installed: false)  →  usable 0xf67556bf
#305  configured 0xe95382df (installed: true)   →  usable 0xe95382df
```

面板在兩者不同時會顯示警示：`⚠ DB 記的 key 0x7db20115 鏈上沒安裝；實際會用 0xf67556bf`。

⚠ `error` 欄位：`usable: null` **只有在 `error === null` 時**才可以讀成「沒有可用的 key」。讀不到安裝狀態（RPC 掛）不是同一件事。
