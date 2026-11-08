# User flows

> 這份文件畫的是**使用者實際會走的路徑**，以及每一步在後端／鏈上發生什麼事。
> 對照程式碼：`src/components/WalletMenu.tsx`（登入）、`src/features/create/CreateFundPage.tsx`（建基金）、
> `src/features/rebalance/RebalanceCard.tsx`（再平衡）、`src/features/renewal/RenewalCard.tsx`（續期）。

---

## 0. 一張圖看完

```mermaid
flowchart TD
    A([使用者打開 /vaults]) --> B{已登入?}
    B -- 否 --> C[Connect wallet<br/>標頭下拉選單]
    C --> C1[列出 EIP-6963 錢包]
    C1 --> C2[選一個 → 連線]
    C2 --> C3[Sign in with SIWE<br/>簽 EIP-4361 訊息，不是交易]
    C3 --> D
    B -- 是 --> D[瀏覽 9 檔範例基金<br/>Category 篩選 / Filter funds]

    D --> E{要做什麼?}
    E -- 建新基金 --> F[Create fund]
    E -- 看自己的 --> G["/portfolios"]
    E -- 操作某一檔 --> H["/portfolios/:id"]

    F --> F1[取名稱]
    F1 --> F2[選資產 + 權重<br/>沒有 oracle 的資產是灰的]
    F2 --> F3[選節奏 Hourly / 6h / Daily]
    F3 --> F4[Create fund]

    F4 --> S1[strategy<br/>+ 鏈上 registry]
    S1 --> S2[version<br/>權重 + 排程]
    S2 --> S3[enroll<br/>部署 Kernel 帳戶 + 裝 session key]
    S3 --> F5{帳戶有 gas?}
    F5 -- 沒有 --> F6[錢包轉 shortfall<br/>約 0.01 BNB]
    F5 -- 有 --> F7
    F6 --> F7[簽一次：approve 各資產給 executor]
    F7 --> F8([完成：帳戶可再平衡])

    G --> G1[Your funds：每個 smart account 的總值與漂移]
    G1 --> G2[Activity：每一輪的前後漂移]
    G2 --> H

    H --> H1{有錢嗎?}
    H1 -- 空倉 --> H2[Needs funding<br/>先入金 USDT]
    H1 -- 有 --> H3[Re-analyse<br/>dry-run 預覽這一輪會做什麼]
    H3 --> H4{預覽結果}
    H4 -- noop --> H5[什麼都不做<br/>並說明為什麼]
    H4 -- blocked --> H6[前置檢查沒過<br/>allowance / gas / session key]
    H4 -- ready --> H7[勾選確認 → Confirm and send]
    H7 --> H8[session key 簽 UserOp<br/>→ bundler → 上鏈]
    H8 --> H9[before/after 快照<br/>算出這一輪的實際效果]
    H9 --> G2
```

---

## 1. 登入（沒有交易、沒有 gas）

```mermaid
sequenceDiagram
    autonumber
    actor U as 使用者
    participant W as 瀏覽器錢包<br/>(MetaMask…)
    participant App as cre8-app
    participant BE as backend
    participant DB as Postgres

    U->>App: 點 Connect wallet（標頭）
    App->>W: EIP-6963 偵測（announceProvider）
    W-->>App: 錢包清單（name / icon / rdns）
    U->>App: 選一個錢包
    App->>W: eth_requestAccounts
    W-->>App: address

    U->>App: Sign in with SIWE
    App->>BE: POST /auth/nonce
    BE->>DB: 存一次性 nonce（5 分鐘）
    BE-->>App: domain / chainId / nonce / uri / statement
    App->>W: personal_sign(EIP-4361 訊息)
    W-->>U: 顯示「這是登入，不是交易」
    U->>W: 簽名
    W-->>App: signature
    App->>BE: POST /auth/login {message, signature}
    BE->>BE: 還原位址 + 驗 nonce + 驗 domain/chainId
    BE->>DB: insert auth_sessions（存 sha256(token)）
    BE-->>App: {token, expiresAt}
    App->>App: sessionStorage 保存（重新整理仍在，關掉分頁消失）
```

**重點**：SIWE 只是證明「你擁有這個位址」。**鏈上權限與 session key 完全不受影響** ——
登入與否不改變任何合約狀態。

---

## 2. 建立基金：3 個 API + 2 次錢包互動

```mermaid
sequenceDiagram
    autonumber
    actor U as 使用者（owner）
    participant App as cre8-app
    participant BE as backend
    participant Reg as AtpRegistry
    participant Fac as MetaFactory
    participant Acct as Kernel 帳戶
    participant Er as AtpExecutor

    U->>App: 填名稱 / 權重 / 節奏 → Create fund
    App->>BE: POST /strategies {name}
    BE->>Reg: registerStrategy(name)（operator 送）
    Reg-->>BE: onchain id
    BE-->>App: {id, onchainId}

    App->>BE: POST /strategies/:id/versions {allocation, schedule}
    BE->>Reg: publishVersion(assets[], weightsBps[])（operator 送）
    Note over Reg: 版本一旦發布就不可改<br/>改權重 = 發新版本
    BE-->>App: {version: 1}

    App->>BE: POST /portfolios {strategyId}
    BE->>BE: 派生 session key（master seed + index）
    BE->>BE: 組 initConfig（權限）與 salt=keccak(owner, strategyId)
    BE->>Fac: deployWithFactory(...)（operator 送）
    Fac->>Acct: 部署帳戶 + 安裝 session key
    BE->>Reg: enroll(account, id)（operator 送）
    BE->>BE: 寫 DB（portfolios / smart_accounts / session_keys）
    BE-->>App: {portfolio, gas: {shortfallWei}}

    alt 帳戶 gas 不足
        App->>U: 請錢包轉 shortfall（約 0.01 BNB）
        U->>Acct: transfer(BNB)
    end

    App->>U: 一次簽名：approve(USDT/NVDAB/WBNB → executor)
    U->>Acct: 簽 sudo UserOp
    Acct->>Er: approve（每個資產，無限額度）
    App->>App: 完成（Allowance 全 ok）
```

**為什麼 approve 是 owner 簽、而部署不是**：`AtpExecutor._swap` 用 ERC-20
`safeTransferFrom` 從**帳戶**拉幣，所以 allowance 必須由帳戶給。session key 給不了
（CallPolicy 只白名單 `executeRebalance`），而後端沒有 owner 私鑰。詳見 `architecture.md`。

---

## 3. 一輪再平衡（沒有簽名）

```mermaid
sequenceDiagram
    autonumber
    actor U as 使用者
    participant App as cre8-app
    participant BE as backend
    participant Chain as BSC (fork/主網)
    participant Bund as alto bundler
    participant Ex as AtpExecutor
    participant Orac as AtpMultiPoolOracle

    U->>App: Re-analyse
    App->>BE: GET /portfolios/:id/plan（dry-run）
    BE->>Chain: 讀持倉（Transfer 日誌 + 多呼叫）+ 定價
    BE->>BE: 算漂移 → 目標差 → 每步 amountIn
    BE->>Chain: 前置檢查：session key 已裝? allowance? 餘額?
    BE-->>App: noop / blocked / ready + steps + 理由

    U->>App: 勾選 → Confirm and send
    App->>BE: POST /portfolios/:id/rebalance
    BE->>BE: 規劃（含 impact 上限）
    BE->>BE: 寫 before 快照
    BE->>Bund: eth_sendUserOperation（session key 簽）
    Bund->>Chain: handleOps
    Chain->>Ex: executeRebalance(account, steps, deadline)
    Ex->>Orac: previewSwap 取 TWAP 地板
    Ex->>Ex: 每個 step：safeTransferFrom → swap → 轉出
    Chain-->>BE: receipt
    BE->>BE: 寫 after 快照
    BE-->>App: {outcome, tx, steps}
    App->>U: 顯示 executed + 前後漂移

    Note over BE: 同一條路徑也由常駐排程器<br/>每 60 秒自動跑（--loop --live）
```

---

## 4. Session key 到期 → 續期

```mermaid
flowchart LR
    A["排程器 / 告警<br/>偵測 key 剩少於 30 天"] -->|warn| B[使用者看到提醒]
    A -->|"剩少於 7 天：critical"| B
    B --> C["/portfolios/:id<br/>Install a new session key"]
    C --> D[GET /renewal-params<br/>後端派生新 key + initConfig]
    D --> E[owner 錢包簽一筆 sudo UserOp]
    E --> F[帳戶 installValidation<br/>把新權限裝到自己身上]
    F --> G[POST /renewal-result<br/>DB 記回新 key]
    G --> H[排程器下次會用新的那把<br/>DB 由新到舊逐把驗鏈上是否安裝]
```

**舊 key 不會被撤銷** —— 它到自己的到期日為止仍然有效。這是刻意的：撤銷需要另一筆交易，
而多一把有效 key 的風險低於「續期失敗導致資金卡住」。

---

## 5. 失敗時使用者會看到什麼

| 情況 | 使用者看到的 | 系統實際狀態 |
|---|---|---|
| 錢包拒絕簽名 | 選單裡留著錯誤訊息，可重試 | 沒有任何鏈上動作 |
| 帳戶沒 gas | approve 失敗，訊息說明 gas | 帳戶存在但付不出 op |
| 沒 approve | 預覽 `blocked`：`ALLOWANCE_TOO_LOW` | 不送交易（不浪費 gas） |
| 空倉 | 預覽 `noop`：`Portfolio value is 0` | 沒有部位可搬 |
| 沒 oracle 的資產 | create 頁該列灰掉 | 選單就擋住，不會建出跑不了的策略 |
| fork/RPC 掛掉 | 503 + 說明「讀不到狀態」 | **不顯示任何漂移數字**（刻意的） |
| 算不出執行後漂移 | `cannot be estimated yet` | 保留完整間隔，不亂調度 |
