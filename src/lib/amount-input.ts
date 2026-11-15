/**
 * 金額輸入框的寬容處理（Postel's law：收得寬、給得乾淨）。
 *
 * 使用者會貼上或打出「1,000」「$100」「100 USDT」「１００」（全形）。原本這些都被 `/^\d+(\.\d*)?$/`
 * 擋掉，按鈕變灰卻沒說為什麼。這裡在 onChange 時先整理成純數字字串，之後的驗證與 `parseUnits` 不變。
 *
 * 這是會動錢的欄位，所以只整理「意思不會變」的部分：
 * - 全形數字與全形句點轉半形；去掉空白、`$`、`＄`、結尾的英文字母（`USDT`、`USD`）。
 *   只看「結尾」且不限 USDT：一個字一個字打「75 USDT」時，打到一半的「75U」也要能整理。
 * - 逗號只在明確是千分位時拿掉（`1,000`、`12,345.6`）。`1,5` 這種可能是歐式小數點的不動，
 *   讓原本的驗證擋下來，避免把 1.5 變成 15。
 * 其餘字元原樣保留，交給原本的驗證決定能不能送出。
 */
export function tidyAmountInput(raw: string): string {
  let value = raw
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/．/g, '.')
    .replace(/\s+/g, '')
    .replace(/^[$＄]/, '')
    .replace(/[a-z]+$/i, '');
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(value)) value = value.replace(/,/g, '');
  return value;
}
