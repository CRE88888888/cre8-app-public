# UI/UX Handoff — cre8-app

> 給接手這個前端的 agent（或下一輪的自己）。
> 讀完這份你應該能：改一個頁面而不弄壞另一個、知道哪些 class 不能碰、知道改完要驗什麼。
>
> 最後更新：2026-11-11 · 對應 commit：見 `git log --oneline -5`

---

## 0. 這份文件為什麼存在

這個前端有**兩套視覺系統並存**，而且它們會互相踩。不了解這件事的人（包括我）已經踩過
三次：變數撞名導致文字變白、`className="toast"` 撞名導致元素存在但看不見、
`.swap-sub` 兩個元素被塞進同一個 grid 區而重疊。

所以：**動手前先讀第 2 節（兩區原則）與第 6 節（已踩過的坑）**。

---

## 1. 技術棧與版本（別亂升）

| 項目 | 版本 | 備註 |
|---|---|---|
| React | 19 | |
| Vite | 7 | |
| TypeScript | strict + `noUnusedLocals` + `verbatimModuleSyntax` | 未使用的 import 會讓 build 失敗 |
| **shadcn/ui** | CLI 4.157 / style `new-york` | 元件是「複製進 repo」的原始碼，不是 npm 依賴 |
| Tailwind CSS | **v4** | ⚠ 沒有 preflight（見 §3） |
| viem / wagmi-less | viem 2.x | 不裝 wagmi，錢包直接用 EIP-1193 provider |
| @zerodev/sdk | **5.5.11 與 5.4.9（ecdsa-validator）**，**必須與 backend 完全一致** | 版本不同 → Kernel 簽章驗證失敗（AA24） |
| 狀態 | zustand（wallet / session）+ TanStack Query（server state） | |
| 套件管理器 | bun | `bun install` / `bun run dev` |

```bash
bun install
bun run dev        # :5173，代理 /api → 127.0.0.1:8081、/rpc → 127.0.0.1:8545
bun run typecheck  # 送出前必跑
bun run build      # = typecheck + vite build
```

---

## 2. ★ 兩區原則（最重要）

這個 app 的畫面有兩種性質完全不同的區塊。**先判斷你在哪一區，再決定怎麼寫**：

| | **A. 公開市集頁** | **B. 營運/工具頁** |
|---|---|---|
| 路由 | `/vaults`、`/funds/:slug`、`/strategies/:id`、`/portfolios` | `/operator`、`/create`、抽屜、表單 |
| 樣式來源 | `styles/vendor/design.css` + `fund-explore.css`（**設計稿的逐字複本**）| 我們自己寫的 class + shadcn |
| 方針 | **保留手寫 class**，不要換成 shadcn | **優先使用 shadcn 元件** |
| 為什麼 | 那些 class 就是設計稿的一部分，換掉等於重新設計 | 這裡的價值是 a11y / focus trap / 鍵盤操作 |

### 絕對不要做的事

```
❌ 編輯 styles/vendor/design.css（那是設計稿的逐字複本，改了就跟來源對不上）
❌ 在市集頁把 .fund-row / .dk-table / .ticket 換成 shadcn
❌ 在 B 區自己發明 class 名稱（先查 CSS 有沒有定義 —— .table-wrap 就是血的教訓）
```

### 已存在的 `src/styles/`

```
vendor/design.css        設計稿複本（4506 行）—— 只讀
vendor/fund-explore.css  市集頁版面 —— 只讀
base.css / components.css / tokens.css / phase-banner.css   我們自己的
shadcn.css               Tailwind 入口 + shadcn token（見 §3）
```

---

## 3. ★ shadcn 的三個硬性設定

### 3.1 沒有 preflight（而且 `@source` 是必要配套）

```css
/* src/styles/shadcn.css */
@import "tailwindcss/theme.css"      layer(theme);
@import "tw-animate-css";            /* Radix 的 data-state 動畫需要它 */
@import "tailwindcss/utilities.css"  layer(utilities);
@source "../";                        /* ⚠ 拿掉 = 所有工具類別都不會被生成 */
```

**為什麼沒有 preflight**：`design.css` 靠瀏覽器預設樣式（標題 margin、border 寬度）撐版面。
引入 preflight 會歸零它們 → 市集頁版面直接壞掉。

**代價**：`@import "tailwindcss"` 的那一行同時帶進「自動偵測原始碼」；我們只 import
theme + utilities，所以**必須自己寫 `@source`**。少了它，`h-4 w-4` 這種工具類別
**完全不會被生成**，症狀是「元件有渲染、完全沒樣式」。

### 3.2 shadcn 的 token 全部加 `sx-` 前綴

```css
--sx-muted: oklch(0.96 0.01 240);   /* shadcn 的「近白表面」 */
@theme inline { --color-muted: var(--sx-muted); }
```

**為什麼**：`design.css` 已經用了 `--muted`（灰色**文字** `#2B4254`）、`--card`、`--border`。
直接覆寫會讓 `/operator` 整排標籤變成白底白字（實測過）。

> 需要真正的深灰文字時，用 `text-[var(--muted)]`（design.css 的值），不要用
> `text-muted-foreground`（shadcn 的近白色）。

### 3.3 可用的 shadcn 元件（已 install）

```
src/components/ui/{sonner,button,badge,sheet,tabs,alert,table}.tsx
```

要加新的：`BUN_INSTALL_CACHE_DIR=$PWD/.bun-cache bunx shadcn@latest add <name> --yes`
（bun 的預設快取目錄在沙箱不可寫）。

---

## 4. 已建立的慣例（照做，不要另創）

### 4.1 Toast：`src/components/Toast.tsx`

```ts
const id = toast.pending('Deposit', 'Confirm the transfer in your wallet…');
toast.replace(id, { tone: 'ok', title: 'Deposited 5 USDT', body: txHash });
```

* `pending` **不自動消失**（等 `replace` 給結果）；其餘 8s / 12s / 15s
* ⚠ **`replace` 回傳新 id**：多階段流程要**接住**它，否則前一則 pending 會永遠在轉
* 底層是 **sonner**（`ui/sonner.tsx`）。不要自己寫 toast。

### 4.2 深連結（給客服/營運截圖用）

```
/funds/<slug>?facts=1      直接開 Fund facts 抽屜
/funds/<slug>?position=1   直接開 My position 抽屜
/funds/<slug>?tab=withdraw 直接切到 Withdraw 分頁
```

新抽屜/分頁請沿用這個模式（`useSearchParams` 初始化 state），這樣才能被截圖測試。

### 4.3 抽屜一律用 `<Sheet>`

```tsx
<Sheet open={open} onOpenChange={setOpen}>
  <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">
```

`p-0` 是必要的：`SheetContent` 預設 `p-6`，再疊上我們自己的 padding 會變成兩層。

### 4.4 Mutation 後要失效**整條依賴鏈**

```ts
await Promise.all([
  invalidateQueries({ queryKey: ['strategies'],           refetchType: 'all' }),
  invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
  invalidateQueries({ queryKey: ['fund-status'],          refetchType: 'all' }),
]);
```

`held`（有沒有部位）依賴 `strategies → holding → fund-status`。只失效 `portfolios`
會讓「My position」按鈕要重整才出現（實測）。

`refetchType: 'all'` 也是必要的：`fund-status` 的 key 帶 `holding?.id`，剛 enroll 完那一輪
是 `undefined` 且 `enabled: false` —— 預設只重抓 active 查詢會跳過它。

### 4.5 文案與語言

* **UI 文案一律英文**（使用者要求）
* **程式註解一律中文**，重點寫「為什麼」而不是「做什麼」
* 金額、地址：`formatUsd` / `shortAddress`（`src/lib/format.ts`）
* 不要寫假的績效數字；市集頁的曲線標明 `Simulated performance`

---

## 5. 錢包 / 鏈（會咬人的地方）

### 5.1 鏈是**建置時**決定的

```ts
// src/lib/kernel.ts
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1337);
```

`.env.production` 固定 `VITE_CHAIN_ID=56`（主網），`.env.development` 是 1337（本機 fork）。
**換鏈要重新 build**，不是改執行時變數。

### 5.2 三個「帳號/鏈」一致性機制（都是踩過才加的）

| 機制 | 檔案 | 作用 |
|---|---|---|
| 自動接回 | `lib/use-auto-connect.ts` | 重整後用 `eth_accounts`（**不彈窗**）接回上次的錢包 |
| 監聽切換 | `lib/use-account-watch.ts` | `accountsChanged` → 更新 wallet store、清掉不匹配的 SIWE session |
| 主動切鏈 | `lib/wallet.ts` `ensureChain()` | 連上後切到 `CHAIN_ID`，不認識就 `addEthereumChain` |

**為什麼需要**：SIWE token 綁「簽名那一刻的錢包」，而 `authenticate` 是純 token→wallet。
切了帳號但沒清 token，就會拿 A 的 token 去查 B 的投組 → 403 → 畫面什麼都不顯示。

### 5.3 使用者簽名只發生在三個地方

```
① SIWE 登入（eth_sign / personal_sign）
② approve（授權 executor 花帳戶的代幣）—— 只在 allowance === 0 時才要
③ 提領/清倉的最後一筆 transfer（sudo UserOp）
```

**再平衡不需要使用者簽名** —— 那是 session key 代簽。若 UI 讓你以為要簽，那是 bug。

---

## 6. ★ 已踩過的坑（照這個順序排查）

| 症狀 | 真正原因 | 修法 |
|---|---|---|
| 元素存在但看不見 | `className` 與 `design.css` 撞名（`.toast` 有 `opacity: 0`） | 加前綴（`app-toast`），或先 `grep` 設計稿 |
| 文字變近白、看不見 | shadcn 的 `--muted` 覆寫了 design.css 的 `--muted` | shadcn token 全部 `sx-` 前綴 |
| 元件有渲染沒樣式 | 缺 `@source` → 工具類別沒生成 | `src/styles/shadcn.css` 的 `@source "../"` |
| 兩行文字重疊 | `.swap-sub` 在 ticket 裡是 grid 的 `sub` 區，兩個元素塞同一格 | 合併成一個 `.swap-sub` |
| 按鈕默默變灰、沒說明 | `disabled` 條件沒有對應文案 | 在按鈕下方補一行 `fine` 說明 |
| Toast 永遠在轉 | pending 的 id 沒被 `replace` 接住 | `const id = toast.replace(...)` 再 replace 它 |
| 「My position」要重整才出現 | 只失效 `portfolios`，漏了 `strategies` / `refetchType` | 見 §4.4 |
| Max 按鈕一按就報「超過總值」 | `toFixed(2)` 四捨五入 | 最大值只能 **向下取整**：`Math.floor(x*100)/100` |
| 錢包顯示 0 餘額、說交易會失敗 | MetaMask 對「它認得的 chainId」用自家後端模擬 | 本機用 1337（它不認識）；這是為什麼有 1337 |
| 簽名被拒（AA24） | 錢包不是帳戶 owner / 前端 `index` 與後端 salt 不一致 | `sendSudoCalls` 會先推導 counterfactual 地址比對並給人話 |

---

## 6.5 ⚠ 「只在我機器上能跑」——本機有 `~/node_modules`

CI 第一次跑就抓到兩個**本機永遠不會發現**的錯誤：

| 錯誤 | 真因 |
|---|---|
| `vite.config.ts: Cannot find module 'node:url'` | TypeScript 會往父目錄找 `node_modules`，撿到了 `~/node_modules/@types/node` |
| `"EventEmitter" is not exported by "__vite-browser-external"` | 同上，撿到了 `~/node_modules/events` |

**驗證方法（重要）**：把原始碼複製到家目錄之外的乾淨目錄，例如
`/private/tmp/cre8-app-check.XXXXXX`，排除根目錄的 `.git/`、`node_modules/`、`dist/`
與 `.bun-cache/`，使用與 CI 相同的 **Bun 1.4.4** 執行：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
```

不要只更改 `HOME`：TypeScript 的父目錄模組解析取決於原始碼所在位置，
原始碼仍在家目錄底下時，依然可能讀到 `~/node_modules`。

> 如果你的機器上沒有 `~/node_modules`，這些錯誤根本不會出現 —— 但別人的機器、
> 或 GitHub runner 上會。**這就是要有 CI 的理由。**

## 7. 目錄地圖

```
src/
├── App.tsx                 路由 + useAutoConnect / useAccountWatch / Toaster
├── components/
│   ├── Toast.tsx           ← 唯一的 toast 入口（sonner adapter）
│   ├── WalletMenu.tsx      連線 / SIWE 登入 / wallet-warning
│   ├── ui/                 shadcn 元件（複製進來的原始碼）
│   └── ui.tsx              Note / ErrorNote / Badge / Spinner（design.css 樣式）
├── features/
│   ├── fund/FundPage.tsx   ★ 最複雜的一頁：Deposit / Withdraw / Close、兩個抽屜
│   ├── operator/           Operator dashboard（scheduler 心跳、活動流、Run round）
│   ├── create/             建基金
│   ├── vaults/             市集目錄
│   └── strategy/, portfolios/, auth/
├── lib/
│   ├── api.ts              所有 API 型別與呼叫（Bearer token）
│   ├── kernel.ts           ★ CHAIN_ID、sendSudoCalls、approve、sendSweep、sendWithdraw
│   ├── wallet.ts           EIP-1193、ensureChain、簽名
│   ├── use-auto-connect.ts / use-account-watch.ts
│   └── format.ts / query.ts
├── store/                  wallet.ts / session.ts（zustand）
└── styles/                 見 §2
```

---

## 8. 驗收清單（改完 UI 必跑）

```
□ bun run typecheck              零錯誤（noUnusedLocals 會抓未使用的 import）
□ bun run build                  成功
□ 手動看三個畫面：
   /vaults                       市集頁版面**沒有變**（這是最容易被 shadcn 弄壞的地方）
   /funds/elon-universe          Deposit / Withdraw / Close 都按得到
   /operator                     System 區塊的標籤**看得清楚**（深灰，不是近白）
□ 深連結可開抽屜：?facts=1 / ?position=1
□ 有一個 toast 會出現且會消失（不是永遠在轉）
```

---

## 9. 部署（不在本文件範圍，但有幾個必知的耦合）

```
Cloudflare Pages（專案 cre8-atp）+ `public/_worker.js` 代理 /api → Railway api
```

* `AUTH_DOMAIN` **必須等於使用者造訪的 host**（例：`beta.cre8.finance`），否則 SIWE 會拒
* 目前網域：`https://beta.cre8.finance`（`app.cre8.finance` 已被既有 Vercel 站佔用）
* 細節見 `docs/deploy-cloudflare.md`

---

## 10. 相關文件

| 文件 | 內容 |
|---|---|
| `docs/shadcn-adoption.md` | 導入順序、哪些元件該換/不該換、兩個坑的完整推導 |
| `docs/deploy-cloudflare.md` | 部署、`/api` 代理、換網域要改哪三處 |
| `docs/architecture.md` | 前端整體架構 |
| `docs/user-flow.md` | 使用者的完整動線 |
| `../../backend/docs/pitfalls.zh-TW.md` | 後端/鏈上的踩坑（很多 UI 症狀的根因在後端） |
| `../../backend/docs/mainnet-todo.zh-TW.md` | 上線前待辦（含 V2 路由、safe-mode 的狀態） |

---

## 11. 如果你只記得三件事

1. **先分區**：市集頁保留手寫 class，工具頁用 shadcn。
2. **不要覆寫 `design.css`**，也不要跟它的 class/變數撞名 —— shadcn token 用 `sx-` 前綴。
3. **非同步狀態要接續完整**：toast 的 `replace` 要接住 id、mutation 後要失效整條依賴鏈。
   這兩件事各自造成過「永遠在轉的 toast」與「要重整才看得到按鈕」。


## 12. 2026-11-11 正式 UI 同步

* 正式 UI 來源：`cre8admin/bnb-agent-vaults` 的已合併 commit
  `4045d854402090255cb36b8b4a84d4f4a30f5561`。沒有帶入來源工作區的未提交修改。
* `styles/formal-ui.css` 只作用在 `atp-formal-market` / `atp-formal-fund` 公開頁。
  vendor CSS、shadcn token 與交易／錢包／API 邏輯未修改。
  vendor 的全域方角規則優先序很高，封面、縮圖與期間按鈕使用頁面內的 id 限定覆蓋。
* 九檔封面和縮圖由 `data/fund-covers.ts` 配對。素材版本、大小與 SHA-256 記在
  `docs/ui-sync-assets-2026-11-11.json`。
* 目錄的搜尋、分類、資產與排序保存在 query string；基金頁的 All funds 會帶回篩選。
  Fund facts 收納模型、資料說明及 Creator，關閉後焦點回到原入口。
* 績效仍是既有的 since-inception 模擬資料；切換期間只改曲線顯示，不產生新報酬。
  Your position 使用現有帳戶估值，不能當成全基金規模。
* `.env.production` 現已實際納入版控：`VITE_CHAIN_ID=56`、`VITE_API_BASE=/api`。
  兩者都是公開建置設定。部署沿用 Cloudflare Git 整合，不新增部署 workflow。
* Operator 的持倉表改用既有 shadcn Table 容器，窄螢幕時表格內捲動。
* 本機驗收：家目錄外 frozen install、typecheck、production build；320/390/1280px
  的目錄、兩個基金頁、Create、Operator 無整頁橫向溢出；抽屜深連結、鍵盤焦點、
  Withdraw 分頁、Close 入口、toast 顯示與到期。需要持倉的畫面使用本機 API fixture；
  沒有驗證真實錢包簽名或執行鏈上交易。


## 13. 2026-11-11 完整公開 UI 整合（取代 §12 的九檔顯示限制）

* 完整來源釘在 `cre8admin/bnb-agent-vaults@0f3196d37821561050dee1176d9d33e3b51c5d5e`。
  30 檔基金（Themes 5 / Public figures 18 / X voices 7）、219 資產頁、218 Create 選項。
  `docs/public-ui-source.json` 記來源、原始檔雜湊、runtime 與基金 payload 雜湊。
* `scripts/sync-public-ui.mjs <source-repo>` 只讀取指定乾淨來源樹；產物在 `src/reference/`。
  原始 NAV、來源調倉與人物資料皆完整保留。型別模組移除不需要的伺服器匯入。
* 新的公開頁元件在 `features/reference/`；來源 CSS 放在 `public-fund-explore.css` /
  `public-detail-source.css`。`complete-ui.css` 僅補整合樣式；vendor 與 shadcn tokens 不變。
  vendor 的方角規則特異性很高，僅用 `#root` / `#atp-reference-sheet` 限定已知例外。
* 新抽屜仍用 shadcn Sheet：`?performance=1`、`?trades=1`、`?update=<id>`、`?tokens=1`。
  手機下單為 `?ticket=1`；`?tab=withdraw` 仍可直接進入提領。
  舊 facts / position 深連結保留。關閉抽屜會恢復已存在入口的鍵盤焦點。
* 財務統計沿用來源選定期間 NAV、日曆日年化及歷史無風險參考利率的前一 NAV 日對齊；Sharpe / volatility
  需至少 90 個連續日報酬。完整計算說明放在 Performance details，不塞滿基本頁。
* `public-funds.ts` 的目前持倉可隨日價漂移；ATP 目標配置使用 `backtest.targets`，
  不能把漂移後權重當成目標。不支援資產不會映射成 USDT。
* `/create` 是完整設計／匯出；原生啟用移到 `/create/activate`。只匯入精確地址的配置，
  逐一核對 API 可交易清單；其他設計規則需明確確認不會執行。
* `/reference-data/demo-funds` 是固定上游的 GET/HEAD 只讀代理，不轉發錢包憑證。
  每日更新須包含同一份完整目錄、連續 NAV、吻合的統計與完整調倉結構；驗證失敗不套用。
  資產頁行情仍顯示自身原始資料時間，不冒充即時報價。
* Kernel、wallet、SIWE、session、API 型別與簽名實作未改；原有 mutation invalidation 保留。
  部署繼續走 Cloudflare Git 整合，主網 chain 56；登入正式網域仍是 beta.cre8.finance。
* 詳細驗收與限制見 `docs/public-ui-integration.md`；測試使用唯讀錢包 fixture，未送真實簽名或交易。
