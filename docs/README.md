# cre8-app 文件

這兩份是**讀程式之前先看**的文件：一份講使用者會走哪些路徑，一份講錢在哪裡、誰能動它。

| 文件 | 內容 | 什麼時候看 |
|---|---|---|
| [`user-flow.md`](./user-flow.md) | 使用者流程圖：登入、建基金、再平衡、續期、失敗時看到什麼 | 想知道「按下去會發生什麼」 |
| [`architecture.md`](./architecture.md) | 合約架構、ERC 標準、帳戶與安全模型、後端架構、DB schema | 想知道「錢在哪裡、誰能動」 |

兩份都是用 **Mermaid** 寫的，GitHub 會直接渲染成圖。

## 三句話版本

1. **每個（使用者, 策略）組合得到一個 Kernel v3.3 智慧帳戶（ERC-4337）** —— 錢在帳戶裡，
   策略本身只是 registry 上的資料（**沒有為每個策略部署合約**）。
2. **後端只能提出意圖**：它用一把 session key 送 UserOp，而那把 key 的 CallPolicy
   只允許呼叫 `executeRebalance`；能換哪些幣、最少拿到多少，由 `AtpExecutor` 在鏈上驗。
3. **owner 私鑰是唯一完全控制者**：非託管。使用者只需要簽三種東西 —— SIWE 登入、
   安裝 session key、approve 資產。

## 不在這個 repo 的文件

`pitfalls`（實作踩過的坑）與 `decisions`（決策記錄）目前放在
`cre8-protocol/docs/`，**尚未納入任何 git repo**。上主網前應該一起版控 ——
那些是「為什麼這樣做」的唯一來源。
