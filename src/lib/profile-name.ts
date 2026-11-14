/**
 * 使用者自己取的顯示名稱（純邏輯）。
 *
 * 後端還沒有用戶資料，所以名字**存在這台裝置**（`store/profile-names.ts`，localStorage），以錢包主人地址為鍵，
 * 只有本人看得到。之後後端有用戶資料 API 時，改成存後端即可，畫面不用動。
 *
 * 顯示順序：自己取的名字 → 已綁帳號的名字（X、Google、email，見 `lib/privy-owner.ts` 的 `profileOf`）→ 錢包地址。
 */

/** 名字最長幾個字（以使用者看到的「字」計，中文、emoji 都算一個）。 */
export const DISPLAY_NAME_MAX = 24;

/**
 * 整理使用者輸入的名字：去掉控制字元與換行、把連續空白併成一個、去頭尾空白、截到上限。
 * 回空字串＝沒有名字（清掉自己取的，回到已綁帳號的名字）。
 */
export function cleanDisplayName(input: string): string {
  const flat = input
    .normalize('NFC')
    // 控制字元、零寬字元、方向控制字元：看不到卻會讓名字長得一樣或版面亂掉。
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...flat].slice(0, DISPLAY_NAME_MAX).join('').trim();
}

/** 畫面上要顯示的名字；都沒有回 null（呼叫端改顯示地址）。 */
export function displayNameOf(input: { custom: string | null | undefined; linked: string | null | undefined }): string | null {
  const custom = cleanDisplayName(input.custom ?? '');
  if (custom !== '') return custom;
  const linked = (input.linked ?? '').trim();
  return linked === '' ? null : linked;
}

/** 頭像沒有圖片時顯示的那一個字。 */
export function initialOf(name: string | null): string | null {
  const first = name === null ? undefined : [...name.trim()][0];
  return first === undefined ? null : first.toUpperCase();
}
