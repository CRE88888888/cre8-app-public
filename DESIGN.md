# CRE8 design system — ATP

本專案適用規格取自 CRE8 已核准的 [DESIGN.md](https://github.com/cre8admin/bnb-agent-vaults/blob/0f3196d37821561050dee1176d9d33e3b51c5d5e/DESIGN.md)。來源 commit：`0f3196d37821561050dee1176d9d33e3b51c5d5e`（2026-11-11 同步）。下列只整理已決定的 App 規則；來源 P3–P6 等待確認提案不當作新規格。

## Typography and colour

- Geist：標題、內文、標籤與按鈕；Geist Mono：數字、代號、地址與期間切換；Anton 只用於 CRE8 字標。
- 按鈕為 sentence case、500 weight、0 letter spacing。一般按鈕 15px；小按鈕與錢包 14px。控制項與標籤至少 12px。
- 使用既有 token：ink `#16222D`、deep `#2B4254`、steel `#4E6A7F`、fog `#6F93AE`、snow `#EEF3F7`、paper `#F7F9FB`、white `#FFFFFF`。
- 次要文字為 steel；slate `#8297A8` 只用於 disabled。正／負／警告使用 positive `#2C7A68`、negative `#A04E58`、caution `#8A5A1F`。
- 頁面預設 paper、panel 白底、1px hair 邊框、無陰影。公開基金列表與詳情沿用已核准白底。

## Controls

| Control | Approved appearance |
| --- | --- |
| Main action | Ink background, snow text, ink border; 46px minimum, 22px horizontal padding; square |
| Secondary action | Transparent background, ink text, hair-2 border; hover ink border |
| Small action | 38px minimum, 16px horizontal padding, 14px type; coarse pointer 40px |
| Connect wallet | Shared across pages: 40px height, 10px radius, 16px horizontal padding, 14px Geist 500; ink/snow |
| Ticket action | 52px; 11px radius; 15px Geist 500 |
| Mobile fund action bar | 56px actions; existing ticket opens in a modal sheet |
| Segmented control | 36px; coarse pointer 40px; 14px horizontal padding; 12px Geist Mono, .04em letter spacing; square joined segments; active ink/snow |
| Disabled | Snow background, slate text, hair border; no hover action |
| Focus | 2px fog outline, offset 3px; do not leave a focus ring after pointer-only clicks |

主導覽選中為平直 2px 底線、0px 圓角。不要把錢包圓角套到全部 header 控制項。

## Layout, images and dialogs

- 一般手機 gutter 16px。基金探索白底、淡列線；桌面最多 1344px / 40px gutter，既有基金圖像規則保留。
- 基金縮圖 22% 圓角、桌面封面 12px、手機封面滿版方角。這是圖片例外，不延伸到分段控制與一般按鈕。
- 手機基金詳情主報酬 40px Geist、底部主要操作 56px。
- 抽屜使用現有 Radix Sheet，保留背景鎖定、Escape、focus trap 與關閉後還原焦點。關閉按鈕需有可辨識名稱及可操作範圍。
- 所有寬度不得整頁橫向溢出。驗收 320、360、390、430、768、1024、1440、1920px。
- `prefers-reduced-motion` 關閉非必要動畫與平滑捲動。

## ATP integration and data

- Vendor CSS 與 `src/reference/` 的同步來源保留；整合覆蓋放在本專案自己的樣式。Tailwind 不載入 preflight，shadcn token 保留 `sx-` 前綴。
- Native wallet、API、transaction handler、authorization 與 mutation invalidation 不因樣式調整而更動。
- 2026-11-11 使用者要求移除全站 Testnet phase 跑馬燈；保留既有模型／歷史資料性質的標示。
- Leaderboard 一列代表一個 creator，按 creator address 分組；公開人物與 X voices 是參考模型題材，不代表本人建立基金。
- Creator 的模型平均報酬必須明示口徑；不可把模型規模當成真實資金，或把各基金持有人數相加當作去重人數。

## Mobile app experiment

此試作分支在 720px 以下使用固定底部導覽；基金詳情改顯示入金／出金操作列。探索保留原有 URL 篩選，手機將資產、期間和排序放進同一個 Radix 底部抽屜。抽屜預留安全區，並保留 Escape、焦點限制及關閉後焦點還原。

手機基金票先顯示金額、收款帳戶與網路，再交給既有錢包流程。狀態區分已提交與鏈上已確認；入金和後續配置分開說明。Portfolio 用 Holdings / Activity 切換，手機用列表取代橫向表格；讀不到完整估值時，不顯示部分金額作為總值。

此分支的手機版採用 iOS 風格的共用線條圖示、圓角卡片、浮動導覽與分段控制；適用於探索、基金詳情、交易票券及 Portfolio。紙白與藍灰區隔資訊層級，狀態仍同時用文字表示。基金資料、錢包驗證和交易行為沿用既有流程。

手機版使用系統字體、中性分組背景、白色卡片，以及 CRE8 steel／deep 灰藍作為操作色。探索和 Portfolio 直接以頁面標題開始，基金頁只保留返回及分享圖示；入金／提領抽屜由入口決定模式，不重複呈現切換列。行動與桌面皆保留原本的導覽目的地。
