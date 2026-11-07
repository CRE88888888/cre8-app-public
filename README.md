# cre8-app

CRE8 ATP 的前端。Vite + React 19 + TypeScript，**純 CSS**（不引入 Tailwind 或 UI 套件）。

## 技術選擇

| 層 | 選擇 | 為什麼 |
|---|---|---|
| 建置 | Vite 7 | dev server 啟動 <200ms，HMR 對「改一個表格欄位」這種工作差很多 |
| server state | `@tanstack/react-query` | 快取、重試、`isPending`/`error` 的狀態機。手寫這些每次都會漏一個分支 |
| client state | `zustand` | 只有錢包連線與 token 兩塊，Context 也能做但 zustand 的 selector 不會讓整個樹重繪 |
| 樣式 | 純 CSS + design tokens | 只有幾頁，token + 少量 class 比 utility 好讀、好改 |
| 鏈互動 | `viem` | 型別完整，且與後端同一個版本（`2.57.x`） |

視覺語言（顏色、圓角、字體、卡片/按鈕形狀）取自 `bnb-agent-vaults/web` 的 app 頁；
**landing page 與 docs 頁不參考**。

## 目錄

```
src/
  lib/
    api.ts        後端契約（型別 + fetch wrapper + ApiError）
    format.ts     純格式化：1e8 定點 → "$511,338.07"、bps、地址、日期
    query.ts      QueryClient 與 queryKeys（retry 1、不自動 refetch）
    wallet.ts     EIP-6963 探索、連線、personal_sign、dev 私鑰簽名
  store/
    session.ts    token / expiresAt / address（sessionStorage）
    wallet.ts     連線狀態（provider 留在模組層，不進 store）
  components/     TopBar / RequireSession / Badge・Note・Field・ErrorNote
  features/
    auth/         SIWE 登入
    portfolios/   投組列表
    status/       漂移明細
  styles/         tokens.css / base.css / components.css
```

## 開發

```bash
bun install
bun run dev        # http://localhost:5173
bun run typecheck
bun run build
```

後端要跑在 `127.0.0.1:8081`。`vite.config.ts` 把 `/api/*` proxy 過去（並剝掉前綴），
所以**前端一律打相對路徑** —— 同源就沒有 CORS 與 preflight，部署時由反向代理做同一件事。

`VITE_API_BASE` 可覆寫（預設 `/api`）。

### 登入

1. 連錢包（EIP-6963 清單，或 dev build 的私鑰入口）
2. `POST /api/auth/nonce` 取得 SIWE challenge
3. 錢包簽 `personal_sign`
4. `POST /api/auth/login` 換 token → 存 sessionStorage

**為什麼是 sessionStorage 不是 localStorage**：這支 app 會動錢，token 的曝險窗口應該跟「這個分頁開著」
一樣長。重新整理不用重簽，關掉分頁就清掉。

## 這一版做到哪裡

已完成一條完整的線：**登入 → 投組列表 → 漂移明細**。

還沒做（下一個 slice）：
- 續期流程（`GET /renewal-params` → 組 UserOp → `POST /renewal-result`）
- 再平衡確認與送出（`POST /portfolios/:id/rebalance`，後端預設 **403 `OPERATOR_REBALANCE_DISABLED`**）

## 兩個刻意的顯示決定

**① 讀不到狀態時，不顯示任何漂移數字。**
`GET /portfolios/:id/status` 失敗（503）時，這一頁只顯示錯誤，不顯示「漂移 0、不需要再平衡」。
一個看起來正常的零比一個錯誤訊息危險得多。

**② `GET /portfolios/:id/status` 的 `sessionKey` 有兩種 key。**

| 欄位 | 意思 |
|---|---|
| `configured` | DB 記的最新那把（＝列表頁顯示的那把）。**可能沒安裝在鏈上** |
| `usable` | 排程器實際會用的那把（由新到舊逐把驗） |

兩者不同時畫面會警告「DB 記的 key 鏈上沒安裝；實際會用 X」。`usable === null` **只有在
`error === null`** 時才可以讀成「沒有可用的 key」。

## 驗證方式

`lib/format.ts` 沒有 DOM、沒有 fetch、沒有 React，所以可以直接驗算：

```bash
bun -e 'import {formatUsdE8} from "./src/lib/format.ts"; console.log(formatUsdE8("51133807293686"))'
# $511,338.07
```

金額一律走 BigInt：`123456789012345678` → `$1,234,567,890.12`（用 Number 會失真）。

## 一個踩過的契約坑

`GET /portfolios` 回的是 **`{ portfolios: [...] }`**，不是裸陣列。型別寫成 `Portfolio[]` 時
TypeScript 不會有任何意見（`request<T>` 只是斷言），執行期卻會在 `.map` 爆掉、畫面空白。
`lib/api.ts` 現在把 wire 形狀寫出來並在客戶端拆掉。
