/**
 * `@solana-program/system` 的替身（cre8-app#57）。只在打包時用（`vite.config.ts` 的 alias）。
 *
 * Privy SDK 內建 Solana 的畫面，從這個**選用**的 peer dependency 匯入 `getTransferSolInstruction`。
 * 我們只用 EVM、沒有裝它，Vite 8 會因為「匯入的名字不存在」而讓整個 build 失敗。
 * 這個 app 不會走到 Solana 的流程；真的被呼叫就丟錯，不要假裝成功。
 */
export function getTransferSolInstruction(): never {
  throw new Error('Solana is not enabled in this app');
}
