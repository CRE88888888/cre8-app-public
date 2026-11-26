/**
 * 地址簿一致性檢查（審查 #95 第 1 項）：app 內建的合約地址簿（chain 97 由 cre8-contracts manifest 產生，
 * `lib/testnet-97.ts`）必須和後端實際在用的一樣，才送需要簽名的交易。後端公開的 `GET /platform/status`
 * 回它設定的 chainId、registry、executor；任何一個對不上、或讀不到，就不簽、不送。
 *
 * 只在地址簿有 registry 的鏈（chain 97）檢查；chain 56 的合約地址由後端給，不在 app 裡。
 * 純邏輯＋可注入的讀取：不碰 React。
 */
export type AddressBook = { chainId: number; registry: string; executor: string };

/** 地址簿和後端對不上（或確認不了）：不簽、不送。 */
export class AddressBookMismatchError extends Error {
  constructor(public readonly reason: string) {
    super(`This app's contract addresses don't match the platform's (${reason}), so nothing was signed or sent. Refresh the page and try again later.`);
    this.name = 'AddressBookMismatchError';
  }
}

const sameAddress = (a: unknown, b: string): boolean => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();

/** 對得上回 null；對不上回原因（給錯誤訊息用）。只有 HTTP 200 而且三個欄位都相同才算對得上。 */
export function addressBookMismatch(status: number, text: string, book: AddressBook): string | null {
  if (status !== 200) return 'platform status unavailable';
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return 'platform status unreadable';
  }
  if (typeof body !== 'object' || body === null) return 'platform status unreadable';
  const { chainId, registry, executor } = body as Record<string, unknown>;
  if (chainId !== book.chainId) return 'different network';
  if (!sameAddress(registry, book.registry)) return 'registry differs';
  if (!sameAddress(executor, book.executor)) return 'executor differs';
  return null;
}

/** 讀後端的平台狀態並核對；對不上丟 `AddressBookMismatchError`。`book` 是 null（這條鏈沒有內建地址簿）就不檢查。 */
export async function assertAddressBook(
  book: AddressBook | null,
  read: () => Promise<{ status: number; text: string }>,
): Promise<void> {
  if (book === null) return;
  let response: { status: number; text: string };
  try {
    response = await read();
  } catch {
    throw new AddressBookMismatchError('platform status unavailable');
  }
  const reason = addressBookMismatch(response.status, response.text, book);
  if (reason !== null) throw new AddressBookMismatchError(reason);
}
