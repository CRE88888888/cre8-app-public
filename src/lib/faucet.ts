/**
 * 領測試 USDT（測試網，cre8-app#62）。純邏輯。
 *
 * 後端的 `POST /faucet/usdt`（backend#72 的實作，`src/faucet.ts` 與 `alto/README.md`）：
 *   - 請求 `{ account }`：**已經 enroll、屬於登入者的基金帳戶**（Kernel smart account）。
 *     還沒 enroll 的 counterfactual 地址不收（`FAUCET_ACCOUNT_FORBIDDEN`），所以順序一定是
 *     「加入基金（enroll）→ 領測試 USDT 進該基金帳戶 → 由帳戶餘額買入」。
 *     錢直接進基金帳戶，測試網買入不需要先從自己的錢包轉 USDT（那一筆要 tBNB，email 使用者沒有）。
 *   - 回應 `{ claimId, state, amountWei, txHash }`：
 *       200 `state: "confirmed"`——後端已經看到這筆上鏈。
 *       202 `state: "unknown"`——交易簽好、可能已送出，但結果還不知道；額度照樣算用掉。
 *       502 `state: "failed"`——交易上鏈後被退回；不算用掉額度，可以再領。
 *   - 上限：每人每個 UTC 日一次；全站每個 UTC 日有總量上限；合約對收款地址另有 24 小時的滾動上限。
 *   - 錯誤代碼：
 *       `FAUCET_QUOTA_EXCEEDED`（429）今天領過，或全站今天發完——後端只給這一個代碼，分不出是哪一種。
 *       `FAUCET_RECIPIENT_LIMIT`（429）這個帳戶 24 小時內收到的已達合約上限。
 *       `FAUCET_ACCOUNT_FORBIDDEN`（403）帳戶沒有 enroll，或不是登入者的。
 *       `FAUCET_DISABLED`、`FAUCET_CHAIN_MISMATCH`（503）後端不是跑在測試網上。
 *       其他 `*_UNAVAILABLE`、`RELAYER_BUSY`（503）暫時領不到。
 *
 * 認得這些代碼之外，仍保留寬一點的比對（關鍵字＋HTTP 狀態），後端多了新代碼時不會變成「Unexpected error」。
 */
import { ApiError } from './api';

export type FaucetOutcome =
  | {
      kind: 'claimed';
      message: string;
      txHash: string | null;
      /** 「1,000 test USDT」；後端沒給金額時是「Test USDT」。 */
      amount: string;
      /** false＝後端回 202（結果未知）：要自己等到這筆交易上鏈，才能往下買。 */
      settled: boolean;
    }
  /** 今天領過了，或全站今天發完了（後端不區分）。 */
  | { kind: 'quota'; message: string }
  /** 這個帳戶 24 小時內收到的測試 USDT 已達合約上限。 */
  | { kind: 'limit'; message: string }
  /** 帳戶還沒加入基金，或不是登入的這個人的。 */
  | { kind: 'forbidden'; message: string }
  /** 交易被鏈退回；沒有用掉額度。 */
  | { kind: 'failed'; message: string }
  /** 水龍頭沒開、後端或鏈暫時有問題。 */
  | { kind: 'unavailable'; message: string }
  | { kind: 'signed-out'; message: string };

const NO_VALUE = 'Test tokens have no value.';

/** 後端回 202、這裡也等不到那筆交易時給使用者看的話。再按一次會把已經到帳的錢投進去。 */
export const FAUCET_UNCONFIRMED = {
  message: 'The network has not confirmed the test USDT yet. Wait a minute, then press the button again: whatever has arrived will be invested.',
  title: 'Test USDT not confirmed yet',
} as const;

/** `"10000000000000000000000"`（18 decimals）→ `"10,000"`。讀不出來回 null。 */
export function formatTestUsdt(amountWei: unknown, decimals = 18): string | null {
  if (typeof amountWei !== 'string' || !/^\d+$/.test(amountWei)) return null;
  const whole = BigInt(amountWei) / 10n ** BigInt(decimals);
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function faucetSuccess(body: { amountWei?: unknown; txHash?: unknown; state?: unknown }): Extract<FaucetOutcome, { kind: 'claimed' }> {
  const amount = formatTestUsdt(body.amountWei);
  const label = amount === null ? 'Test USDT' : `${amount} test USDT`;
  // 只有明講 unknown 才當成還沒確定；沒有 state 欄位（舊版或假後端）照已確認處理。
  const settled = body.state !== 'unknown';
  return {
    amount: label,
    kind: 'claimed',
    message: settled
      ? `${label} is on its way to this fund’s account. ${NO_VALUE}`
      : `${label} was requested for this fund’s account, but the network has not confirmed it yet.`,
    settled,
    txHash: typeof body.txHash === 'string' ? body.txHash : null,
  };
}

const QUOTA_MESSAGE = 'No test USDT for you right now: you can claim once a day, and there is a daily total for everyone. Try again after 00:00 UTC.';
const LATER_MESSAGE = 'Test USDT is not available right now. Please try again later.';

export function faucetFailure(error: unknown): FaucetOutcome {
  if (!(error instanceof ApiError)) {
    return { kind: 'unavailable', message: 'Test USDT could not be claimed right now. Please try again later.' };
  }
  const code = error.code.toUpperCase();
  if (error.status === 401) return { kind: 'signed-out', message: 'Sign in again to claim test USDT.' };

  // ---- 後端實作的代碼（backend#72）----
  if (code === 'FAUCET_QUOTA_EXCEEDED') return { kind: 'quota', message: QUOTA_MESSAGE };
  if (code === 'FAUCET_RECIPIENT_LIMIT') {
    return { kind: 'limit', message: 'This fund’s account has received as much test USDT as it can in 24 hours. Try again later.' };
  }
  if (code === 'FAUCET_ACCOUNT_FORBIDDEN') {
    return { kind: 'forbidden', message: 'Test USDT can only go to a fund account you have joined. Reload the page, then try again.' };
  }
  if (code === 'FAUCET_DISABLED' || code === 'FAUCET_CHAIN_MISMATCH') {
    return { kind: 'unavailable', message: 'Test USDT is not set up on this network. Please let the team know.' };
  }
  if (code === 'RELAYER_BUSY') {
    return { kind: 'unavailable', message: 'The test network is busy. Wait a minute, then try again.' };
  }
  // 502：後端把 `state: "failed"` 的結果用 502 回來（沒有 error.code，所以這裡看狀態碼）。
  if (error.status === 502) {
    return { kind: 'failed', message: 'The test USDT transfer did not go through. Please try again.' };
  }

  // ---- 沒見過的代碼：寬一點比對 ----
  if (/QUOTA|ALREADY|CLAIMED|DAILY|EXHAUST|DEPLETED/.test(code) || error.status === 409) {
    return { kind: 'quota', message: QUOTA_MESSAGE };
  }
  if (error.status === 429) {
    return { kind: 'unavailable', message: 'Too many requests. Wait a minute, then try again.' };
  }
  return { kind: 'unavailable', message: LATER_MESSAGE };
}

/**
 * 沒領到測試 USDT、也沒有東西可以投資時丟給畫面的錯誤。`ErrorNote` 認得它，不會顯示成「Unexpected error」。
 */
export class FaucetError extends Error {
  readonly kind: FaucetOutcome['kind'];
  readonly title = 'Test USDT not claimed';
  readonly technical: string;
  constructor(outcome: FaucetOutcome, cause?: unknown) {
    super(outcome.message);
    this.name = 'FaucetError';
    this.kind = outcome.kind;
    this.technical = cause instanceof ApiError ? `${cause.status === 0 ? 'NETWORK' : `${cause.status} · ${cause.code}`}\n${cause.message}` : '';
  }
}
