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
| Main action | Ink background, snow text, ink border; 46px minimum, 22px horizontal padding; capsule |
| Secondary action | Transparent background, ink text, hair-2 border; hover ink border |
| Small action | 38px minimum, 16px horizontal padding, 14px type; coarse pointer 40px |
| Connect wallet | Shared across pages: 40px height, capsule, 16px horizontal padding, 14px Geist 500; ink/snow |
| Ticket action | 52px; capsule; 15px Geist 500 |
| Mobile fund action bar | 56px actions; existing ticket opens in a modal sheet |
| Segmented control | 32px options in a 3px-padded snow capsule (coarse pointer 36px); 14px horizontal padding; 12px Geist Mono, .04em letter spacing; capsule options; active ink/snow |
| Disabled | Snow background, slate text, hair border; no hover action |
| Focus | 2px fog outline, offset 3px; do not leave a focus ring after pointer-only clicks |

主導覽與桌面分頁標籤選中為平直 2px 底線（沒有外框，不需要形狀）。

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

## 2026-11-11 版面與 App 殼層調整

- 桌面（≥720px）頁首、Funds、Creators、Portfolio、Manage、Create、基金詳情共用同一條左緣：1344px／40px gutter（720–1023px 為 24px）。規則集中在 `design-controls.css` 末段。
- 基金列表原為封面卡片格（720–1023px 兩欄、1024px 起三欄）；2026-11-13 改為主打卡 + 排行榜，見下方「2026-11-13 Funds 頁改版」。分類標籤與搜尋、Filters 仍在同一列。
- 頁標題一律使用 fog 句點（Explore funds. / Creators. / Portfolio. / Manage.），手機隱藏句點。桌面主導覽「Leaderboard」改稱 Creators，與頁標題及手機分頁一致。
- 手機分頁根目錄（Funds、Creators、Create、Portfolio、Manage）不顯示網站 logo 列：頁面 h1 作大標題，右上為玻璃圓鈕錢包。捲過約 56px 後出現 scroll edge 霧化與置中小標題。頁面已有大型連線按鈕時，右上錢包隱藏。
- 手機控制層採 Liquid Glass 語言：分頁列與基金頁 Deposit／Withdraw 為浮動玻璃膠囊（半透明白、模糊＋飽和＋提亮、內緣高光、柔和陰影），選中分頁為膠囊內的淡色膠囊。玻璃只用於浮在內容上的控制層，內容本身不用。瀏覽器無法在 iOS Safari 做真正折射，故不使用 SVG displacement；`prefers-reduced-transparency` 或不支援 `backdrop-filter` 時退回實心白。
- 兩個工作區：投資（Funds · Creators · Portfolio）與 Studio（Today · My funds · Create · Earnings）。模式由網址決定（`/studio`、`/create`、`/strategies` 屬於 Studio），右上角文字按鈕「Studio／Investing」切換，支援時以 View Transition 淡入淡出；localStorage 記住上次模式，manifest 的 `/start` 依此導向。Studio 以頂部「Studio」標記、桌面頁首底部深色線、手機深色玻璃分頁列區分。`/operator` 是 CRE8 內部營運後台，不在任何導覽中。列表與按鈕有按壓回饋，`prefers-reduced-motion` 時關閉。
- 手機 Funds 列表一屏約十檔：列高約 72px、縮圖 44px、名稱最多兩行（有機構名時三行）。分類（All／Themes／Public figures／X voices）捲動時固定在頂部列下方。
- 「人名 · 機構」在手機列表中拆成兩行。
- 支援加到主畫面：`public/manifest.webmanifest`（standalone、start_url `/vaults`）與 `public/app-icons/`。
- Studio 資料：My funds = `GET /strategies` 中 provider 等於目前錢包的策略；狀態取自使用者在該策略的帳戶（`/portfolios/:id/status`）。Today 只列需要處理的項目（無帳戶、權限到期／七天內到期、gas 不足、估值不完整、需要入金、需要再平衡），讀不到的值不當成正常或 0。Earnings 後端尚無資料，顯示說明，不放數字。
- 形狀系統（2026-11-11 使用者決定，取代原本的直角按鈕）：會按的東西一律膠囊（只有圖示時為正圓）；文字框與下拉選單為 12px 圓角矩形；卡片、抽屜、封面沿用各自較大的圓角；圖片縮圖維持既有比例。規則集中在 `mobile-app.css` 的 app-shapes layer 末段。
- 不用外框卡片堆版面：摘要區不加灰底外框與頂部粗線，只用底部細線；清單是連續列表、列間細線；狀態標籤為「色點＋文字」，不用外框等寬字小方塊；不放重複的裝飾圖示。
- 桌面頁首：未連錢包時 Connect wallet 為深色主要按鈕，連上後為淺色帳戶膠囊；Studio／Investing 為次要文字按鈕。桌面主要按鈕一律深色（ink）。
- 基金頁（桌面）：報酬標籤在數字上方（「Model return · 期間」），Max drawdown 與 Share price 並排；交易面板內的輸入區不再是框中框。
- Demo 期間，Community 策略（`/funds/strategy/:id`）與 `VITE_LIVE_FUNDS` 列出的範例基金走真實存入／提領；其餘範例基金可操作到送出，送出時顯示 whitelist 提示，不簽名、不送交易。
- 少讓使用者做決定：同一畫面只放一個 Connect wallet／Create fund；項目少時不顯示搜尋與篩選（Creators 9 位以上才顯示，網址已帶篩選時仍顯示以便清除）；Funds 桌面的篩選收成一顆 Filters（與手機一致），有套用時顯示數量。空狀態在桌面置中。
- 模式切換按鈕寫出動作：投資模式為「＋ Creator Studio」（品牌藍灰淡色底），Studio 內為「← Exit Studio」（中性文字按鈕），並附 title 說明。
- 首頁 `/` 在所有網域都是 landing（`public/landing/`）；帶查詢參數的 `/?…` 仍交給 App，保留 Funds 篩選深連結。App 內左上 logo 回到 landing。

## 2026-11-13 Funds 頁改版

使用者決定：前一版「大封面卡片格」像人物相簿，可以大改。參考 Reserve、Ondo、Robinhood 後，Funds 頁（`/vaults`）改成**主打卡 + 一張排行榜**。規則集中在 `src/styles/market.css`（`mkt-` 前綴），元件在 `src/features/vaults/FundBoard.tsx`。

- **主角是數字與持倉，不是照片。** 封面在列表頁縮成 40px 頭像：人物與 X voices 為圓形，主題為 10px 圓角方形，社群策略用名稱縮寫。大封面只留在基金詳情頁。
- **主打（Top performers）**：一副可以左右滑的深色牌（見「設計系統 v2」），目前分類裡報酬最高的六檔。每張有排名、報酬、面積走勢圖、持倉比例條與前三大持倉。只在「沒搜尋、沒篩資產、依報酬排序、且榜上至少十檔」時出現。
- **排行榜**：一張表（欄名下一條線、列間細線，沒有外框）。欄位為排名、頭像＋名稱＋類型、持倉（比例條＋前三大代號與比例）、走勢、報酬、最大回撤。整列是一個連結。720–1099px 收掉回撤、720–899px 再收掉走勢；手機只留排名、名稱、走勢、報酬，沒有面板外框。
- **排序**：桌面可按「Return」「Max drawdown」欄名排序（等同 Filters 裡的 Sort by），目前排序的欄名加粗並帶 ↓。
- **持倉比例條**：前四大各一段、其餘合成一段，顏色由深到淺為 ink → steel → fog → frost → `#dce5ec`。比例條是裝飾，數字另以文字寫出。顯示的代號是底層 ticker（`NVDAB` 顯示成 `NVDA`）。
- **數字一律 Geist Mono**（報酬、回撤、比例、期間標示），正負用 positive／negative，並保留正負號。
- **歷史長度**：歷史比榜上最長者短一個月以上的基金，在報酬下方標「157d history」，避免半年的數字被當成一年來比。
- **Community**（鏈上策略）獨立一區、不排名：它的走勢是依權重生成的示意，不和參考基金混在同一張榜。
- 底色為純白（見「設計系統 v2」）。
- 設計稿有全站 `border-radius: 0 !important`，新元件的圓角必須寫在 `@layer app-shapes` 並加 `!important`。

## 設計系統 v2（2026-11-13）

使用者決定：可以大改，主要靠設計者的判斷；整體圍繞「使用者體驗」「減少摩擦」；可以有表現力，但不要像 AI 套版。**本節與前面各節衝突時，以本節為準。** 規則在 `src/styles/system.css`（共用）、`market.css`（Funds）、`fund-page.css`（基金頁）、`pages.css`（其餘頁面），都在舊樣式之後載入。

### 原則

- **不是每個區塊都是卡片。** 到處用大圓角白卡片當背板會膩，是通用的柔軟風格，不像交易所看板。只有真的是「一個物件」的東西才有外框或底色：主打的深色牌、交易面板、資產頁右側的小卡。其餘區塊（走勢、說明、交易紀錄、持倉、排行榜）用細線與留白分段，像一份排好版的報告。
- **圓角收小。** 標籤 6px、導覽與小按鈕 8px、按鈕與輸入框 10px、卡片與封面 14px。不再是膠囊。圓形只留給人物頭像與資產 logo。手機上浮在內容上的分頁列與底部操作列維持膠囊（它們是浮動的控制層）。
- **不模仿 logo。** 不用翻牌方塊、不用 Anton 當數字字體（使用者明確否決）。主數字就是乾淨的大字。
- **數字是主角。** 報酬是全站唯一的高彩度顏色。

### 顏色

- **全站底色純白**（使用者明確要求：不要藍灰底）。
- ink `#0C1722`、deep `#1F3345`、steel `#556B7D`（次要文字）、slate `#8A9AA8`（disabled）、fog `#6F93AE`、frost `#C2D3E0`。
- 淡色塊（控制項底、滑過的列）用接近中性的淺灰：snow `#EEF0F2`、paper `#F6F7F8`。
- positive `#0A8A5B`、negative `#CF3D44`。
- signal `#2B6FA3` 只用在焦點環、輸入框 focus。
- 深色面（主打牌、資產頁的 Create 卡）：night `#0B1520`，上面的正負報酬用 `#3DDC97`／`#FF8086`。深色只用在「一張牌」的尺度，不鋪整片背景（使用者明確要求）。

### 尺寸

| 項目 | 規格 |
| --- | --- |
| 主要／次要按鈕 | 高 48px、左右 22px、15px Geist 600、10px 圓角；主要為 ink 底白字，次要為 snow 底、無外框 |
| 小按鈕 | 高 34px（觸控裝置 40px）、14px Geist 500 |
| 頁首錢包與模式切換 | 高 40px、14px Geist 600 |
| 交易面板的送出鈕 | 高 54px、16px |
| 輸入框、下拉 | 高 48px、10px 圓角、focus 時 signal 框線＋3px 柔光 |
| 分段控制（期間切換、Buy／Sell） | snow 軌道（10px 圓角）、白色滑塊（7px）帶細陰影、12–13px Geist Mono |
| 主數字 | 基金頁報酬 56px Geist 600；主打牌報酬 44px Geist 600 |

- 頁首（桌面）：sticky、半透明白＋模糊；導覽選中的是一顆 snow 圓角矩形，不再是底線。
- 設計稿有全站 `border-radius: 0 !important`，舊的 app-shapes 又把可按的東西都設成膠囊（權重 1,2,0）。新的圓角寫在 `@layer app-shapes`、加 `!important`，並用 `#root#root` 提高權重。

### 動態

- **主數字滾動進場**（`components/RollingNumber.tsx`）：每個數字從 0 滾到自己的值，一次、約 0.7 秒，沒有外框或底色。只用在一個畫面的主數字。`aria-label` 提供完整字串。
- 主打牌滑過時上浮 3px；列表與基金頁之間用 View Transitions 短淡入（約 0.18 秒）。
- `prefers-reduced-motion` 時不滾動、不上浮、不做換頁動畫。

### 減少摩擦（各頁）

- **用語**：畫面上一律 **Buy／Sell**（使用者決定，比 Deposit／Withdraw 好懂）。程式內部、網址參數（`tab=withdraw`）與 API 仍是 deposit／withdraw。
- **Funds**：主打是一副可以左右滑的深色牌（六張；桌面露出第四張的邊並有左右箭頭）。排行榜是一張表：欄名下一條 ink 線、列間細線、沒有外框。期間（7D／30D／90D／1Y／All）直接在榜的標題列切換；欄名可點擊排序。
- **基金頁**：封面壓矮（248px），Fund facts 與人物介紹疊在封面右下角；Sharpe 與波動直接列在圖表下方（原本要多點一次）；交易面板下方多一段「What you get」（買入前就看到會買到哪些資產）；買入金額有常用金額一鍵帶入（桌面與手機）；持倉表每列有權重條。
- **Creator 頁**：用跟 Funds 同一張榜，不再是大封面卡片格。
- **頁首的入口叫「Create a fund」**（原本是帶圖示的「Creator Studio」按鈕）：寫使用者想做的事，不是內部的區域名稱；不放圖示、沒有底色，頁首只有 Connect wallet 一顆實心按鈕。Studio 內仍是「← Exit Studio」。
- **`/create` 就是基金設計器**，不需要錢包就能開始。`/create/design` 是舊網址，保留。元件是 `src/features/create/FundDesigner.tsx`：2026-11-13 從 `src/reference/components/fund-builder.tsx` 複製出來，讓 app 可以自己安排畫面；邏輯仍然全部來自 `src/reference/lib/fund-builder.ts`，草稿的儲存位置與格式不變（啟用表單讀同一份）。原本的 reference 元件沒有動，也不再被使用。外觀在 `src/styles/builder.css`。
  - **順序是「先做正事」**：① Holdings → ② 名稱與封面 → ③ More options。原本第一屏是一張大封面圖，加資產在兩屏之後。
  - **Holdings**：上方有 Popular 常用資產，一鍵加入；旁邊是 Browse all assets。加入後預設是 Buy & hold，**不會自動彈出策略抽屜**；想調策略的人點該列的策略按鈕。
  - **名稱與封面**：名稱是大輸入框，封面是右邊的縮圖（248px），按 Change cover 才展開選項。
  - **More options** 預設收合：分類、X 帳號、整檔規則都是選填。裡面有設定時標題旁顯示「In use」；裡面的欄位有錯時自動展開。
  - **摘要**跟著捲動；Review 不能按時下方直接說還缺什麼。「Room used」改叫「Capacity used」。
  - 手機：區塊不加外框，用細線分段。
- **`/create/activate` 是啟用表單**（真的建立：createStrategy → publishVersion → enroll → approve）。左邊三個步驟（命名、選資產與權重、再平衡頻率），右邊跟著捲動的「Your fund」摘要。資產是可點的列，勾了才出現權重框；有「Split evenly」；合計用進度條顯示還差多少；按鈕下方一次只說一件還缺的事。未登入時顯示三步驟說明，主要動作是「Design a fund」。
- **資產頁**：跟基金頁同一條左緣（1344px／40px）與右側欄；Create 卡為深色。
- 未動：錢包、SIWE、API、交易與簽名流程的邏輯。

## 基金封面：點畫（2026-11-13）

使用者決定：原本每檔封面各畫各的（彩色 AI 肖像、照片感場景），放在一起很亂。參考 Glider 與 Autopilot 後，30 檔參考基金的封面統一成**點畫（hedcut）**：純白底、黑色墨點與短線，像《華爾街日報》的人像與鈔票上的版畫。

- **圖**：`public/fund-covers/hedcut/<slug>.webp`（800px 大圖）與 `<slug>-thumb.webp`（192px 縮圖）。清單在 `src/lib/public-funds.ts` 的 `HEDCUT_SLUGS`，在那裡覆蓋同步來的 `cover`（來源 `src/reference/` 不能改）。舊封面檔案還留著：設計器的封面選項仍在用。
- **畫什麼**：人物基金畫本人的頭肩像，臉略朝左；主題基金畫一個物件（機櫃、石塊、天平、硬幣、國庫建築）；X 帳號的頭像若不是真人照片（像素圖、動漫、風景），就把那個頭像畫成點畫。
- **構圖固定**：人像的頭寬佔大圖 46%、頭頂上方留 15%、水平置中、肩膀出血到下緣；物件佔 68%、四邊留白。這是 `scripts/hedcut-normalize.py` 自動裁出來的，所以生成時頭大頭小不用計較，只要不碰到上、左、右三邊。縮圖只比大圖緊一點（頭寬約 52%），放進 40px 圓框四周還有留白。
- **版式**：
  - 基金頁封面：淺灰底（paper）、名稱與按鈕在左、點畫在右，圖用 `mix-blend-mode: multiply` 疊上去（白色會消失，不用去背）。人像肩膀出血到框的下緣；物件完整留在框內（`is-object`）。
  - 列表、主打牌、Portfolio、交易面板：白底小頭像，淺色面上加一圈細線。
  - **深色面不反白。** 反白後臉會變成照片負片，所以深色主打牌上只放白底的圓形小頭像。
- **新增一檔的做法**：用同一段畫法描述生成一張正方形 PNG（至少 1024px、純白底、無文字無邊框；人像附本人照片當參考），跑 `scripts/hedcut-normalize.py`，把兩個 webp 放進 `public/fund-covers/hedcut/`，再把 slug 加進 `HEDCUT_SLUGS`（物件類另外加進 `HEDCUT_OBJECTS`）。
- **說明文字**：基金頁「Cover image credits」寫明是 AI 依公開身分參考生成的點畫插圖。
- 樣式集中在 `src/styles/covers.css`。

