/**
 * 領測試 USDT（測試網，cre8-app#62）。純邏輯。
 *
 * 後端的 `POST /faucet/usdt`（backend#69）由 operator 代領 `TestnetUSDT.claimFor(account, amount)`。
 * 兩層上限：合約每個地址每 24 小時 10,000；後端另外限每位使用者每天一次，以及全站總量。
 *
 * ⚠ 寫這個檔案時 backend#69 還沒合併，**錯誤代碼是照 issue 的描述預先對的**：所以這裡用比較寬的比對
 * （代碼裡的關鍵字＋HTTP 狀態），端點定案後再收斂。認不出來的一律給通用訊息。
 */
import { ApiError } from './api';

export type FaucetOutcome =
  | { kind: 'claimed'; message: string; txHash: string | null }
  /** 這位使用者今天已經領過（或這個地址 24 小時內的上限用完）。 */
  | { kind: 'already'; message: string }
  /** 全站今天的額度發完了。 */
  | { kind: 'exhausted'; message: string }
  /** 水龍頭沒開、後端或鏈暫時有問題。 */
  | { kind: 'unavailable'; message: string }
  | { kind: 'signed-out'; message: string };

const NO_VALUE = 'Test tokens have no value.';

/** `"10000000000000000000000"`（18 decimals）→ `"10,000"`。讀不出來回 null。 */
export function formatTestUsdt(amountWei: unknown, decimals = 18): string | null {
  if (typeof amountWei !== 'string' || !/^\d+$/.test(amountWei)) return null;
  const whole = BigInt(amountWei) / 10n ** BigInt(decimals);
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function faucetSuccess(body: { amountWei?: unknown; amount?: unknown; txHash?: unknown }): FaucetOutcome {
  const amount = formatTestUsdt(body.amountWei ?? body.amount);
  return {
    kind: 'claimed',
    message: `${amount === null ? 'Test USDT' : `${amount} test USDT`} is on its way to your wallet. ${NO_VALUE}`,
    txHash: typeof body.txHash === 'string' ? body.txHash : null,
  };
}

/** `nextClaimAt`（ISO 字串或 Unix 秒）→ 「after 14 Nov, 08:00」；沒有就說明天。 */
function whenAgain(next: unknown): string {
  const millis = typeof next === 'number' ? next * 1000 : typeof next === 'string' ? Date.parse(next) : NaN;
  if (!Number.isFinite(millis)) return 'tomorrow';
  return `after ${new Date(millis).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

export function faucetFailure(error: unknown, details: { nextClaimAt?: unknown } = {}): FaucetOutcome {
  if (!(error instanceof ApiError)) {
    return { kind: 'unavailable', message: 'Test USDT could not be claimed right now. Please try again later.' };
  }
  const code = error.code.toUpperCase();
  if (error.status === 401) return { kind: 'signed-out', message: 'Sign in again to claim test USDT.' };
  // 全站額度：先比，因為它的代碼裡也常帶 LIMIT／DAILY。
  if (/SITE|GLOBAL|TOTAL|EXHAUST|DEPLETED|EMPTY|BUDGET/.test(code)) {
    return { kind: 'exhausted', message: 'Today’s test USDT has all been handed out. Come back tomorrow.' };
  }
  if (/ALREADY|CLAIMED|DAILY|COOLDOWN|LIMIT|TOO_SOON/.test(code) || error.status === 409) {
    return { kind: 'already', message: `You have already claimed test USDT today. You can claim again ${whenAgain(details.nextClaimAt)}.` };
  }
  if (error.status === 429) {
    return { kind: 'already', message: 'Too many requests. Wait a minute, then try again.' };
  }
  return { kind: 'unavailable', message: 'Test USDT is not available right now. Please try again later.' };
}
