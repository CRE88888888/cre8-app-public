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

export const QUOTA_MESSAGE = 'You have already claimed today’s 1,000 test USDT, or today’s total for everyone has run out. Come back tomorrow (after 00:00 UTC).';
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

// ---- 迎新與每日領取（backend#94）----

/** 參數總表：迎新 10,000、每日 1,000（測試幣，沒有價值）。 */
export const WELCOME_TEST_USDT = '10,000';
export const DAILY_TEST_USDT = '1,000';

/** 迎新交易送出了但結果還不知道（buy-funding 回 202）：稍後再按一次，後端會接著同一筆。 */
export const WELCOME_PENDING = {
  title: 'Welcome test USDT on its way',
  message: `Your ${WELCOME_TEST_USDT} welcome test USDT has been sent but the network has not confirmed it yet. Wait a minute, then press the button again.`,
} as const;

/** 迎新不能用在這檔了（給了別檔、失敗，或在這檔用完了）：改用每日領取。 */
export const DAILY_REQUIRED = {
  title: 'Claim today’s test USDT',
  message: `The ${WELCOME_TEST_USDT} welcome test USDT is one per person and has already been used. Claim today’s ${DAILY_TEST_USDT} test USDT to invest in this fund.`,
} as const;

/** buy-funding 的錯誤是不是「要改用每日領取」。 */
export function needsDailyFaucet(error: unknown): boolean {
  return error instanceof ApiError && error.code.toUpperCase() === 'DAILY_FAUCET_REQUIRED';
}

/**
 * 每日領取到帳之後要再記一筆投入（funding-lots）。記帳沒成功（後端忙、交易還沒確認）時把 claimId 留在這台裝置，
 * 下一次按買入時先補記，不然那 1,000 只是帳戶裡的現金、不會被買進去。
 */
const claimKey = (portfolioId: number) => `cre8.faucet-claim.${portfolioId}`;
export function rememberClaim(portfolioId: number, claimId: string): void {
  try { localStorage.setItem(claimKey(portfolioId), claimId); } catch { /* 只在這次造訪有效 */ }
}
export function pendingClaim(portfolioId: number): string | null {
  try { return localStorage.getItem(claimKey(portfolioId)); } catch { return null; }
}
export function forgetClaim(portfolioId: number): void {
  try { localStorage.removeItem(claimKey(portfolioId)); } catch { /* 沒有就算了 */ }
}
/**
 * 補記失敗時要不要留著下次再試（cre8-app#93）。預設**留著**：錢已經到帳，丟掉 claimId 就再也排不進買入。
 * 只有後端明確說「這個來源永遠記不成」才丟：
 *   - 400 驗證錯誤（來源格式不對、這條鏈不收這種來源、金額不夠最低投入）
 *   - 403 這筆領取不是這個帳戶的
 *   - 404 基金帳戶不存在
 *   - 409 `FUNDING_EVENT_CONFLICT`（這筆領取已經記在別檔或別的身分上）
 * 401（登入過期）、408、409 忙碌／還沒確認、429、5xx、網路錯誤都是暫時的。
 */
export function retryClaimLater(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.status === 400 || error.status === 403 || error.status === 404) return false;
  if (error.status === 409 && error.code.toUpperCase() === 'FUNDING_EVENT_CONFLICT') return false;
  return true;
}

// ---- 結果不明的每日領取（cre8-app#93）----

/** UTC 日期（`2026-11-16`），水龍頭的額度以 UTC 日計。 */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * 領取的請求送出了、回應卻沒回來（網路斷、逾時、5xx）：後端可能已經 mint，只是這裡拿不到 claimId。
 * 記下「今天這個帳戶有一筆結果不明的領取」，同一天再按遇到「今天領過了」時，講清楚錢可能已經到了，
 * 不是單純叫人明天再來。後端提供原 claim 的查詢之前，前端只能做到這裡。
 */
export function claimOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status === 408 || error.status === 500 || error.status === 503 || error.status === 504;
}
const unknownKey = (portfolioId: number) => `cre8.faucet-unknown.${portfolioId}`;
export function rememberUnknownClaim(portfolioId: number, now: Date = new Date()): void {
  try { localStorage.setItem(unknownKey(portfolioId), utcDay(now)); } catch { /* 只在這次造訪有效 */ }
}
export function hadUnknownClaimToday(portfolioId: number, now: Date = new Date()): boolean {
  try { return localStorage.getItem(unknownKey(portfolioId)) === utcDay(now); } catch { return false; }
}
export function forgetUnknownClaim(portfolioId: number): void {
  try { localStorage.removeItem(unknownKey(portfolioId)); } catch { /* 沒有就算了 */ }
}
export const CLAIM_UNCONFIRMED_TODAY = {
  title: 'Today’s test USDT may already be in the fund',
  message: `Your claim today did not come back, so it could not be scheduled to buy. The ${DAILY_TEST_USDT} test USDT may already be in this fund’s account. You can claim again after 00:00 UTC; contact the team if it does not show up.`,
} as const;

/**
 * 每日領取的冪等契約（backend#97，總管 2026-11-16）：同一天重送 `POST /faucet/usdt`，後端回**原來那筆**
 * （200＋同一個 claimId），不再一律 429。所以「回應遺失」的那一筆，再按一次就拿得回 claimId，照常記成投入。
 * 記帳時回 `replayed` 表示這筆之前就記過了：今天的已經投進去，不是新的錢。
 */
export function dailyClaimAlreadyInvested(lot: { replayed?: boolean } | null | undefined): boolean {
  return lot?.replayed === true;
}

// ---- 迎新還在路上（buy-funding 回 202）----

/**
 * 迎新 202 之後記下 grantId。下一次按買入一定先再問一次 buy-funding（後端會對同一筆交易對帳），
 * 不因為帳戶已經有錢就改走每日領取（cre8-app#93）。
 */
const welcomeKey = (portfolioId: number) => `cre8.welcome-pending.${portfolioId}`;
export function rememberPendingWelcome(portfolioId: number, grantId: string): void {
  try { localStorage.setItem(welcomeKey(portfolioId), grantId); } catch { /* 只在這次造訪有效 */ }
}
export function pendingWelcome(portfolioId: number): string | null {
  try { return localStorage.getItem(welcomeKey(portfolioId)); } catch { return null; }
}
export function forgetPendingWelcome(portfolioId: number): void {
  try { localStorage.removeItem(welcomeKey(portfolioId)); } catch { /* 沒有就算了 */ }
}

/** 已經確定迎新在這個人身上用掉（後端說改領每日，或在這檔記過）：按鈕直接是每日領取。 */
const usedKey = (portfolioId: number) => `cre8.welcome-used.${portfolioId}`;
export function rememberWelcomeUsed(portfolioId: number): void {
  try { localStorage.setItem(usedKey(portfolioId), '1'); } catch { /* 只在這次造訪有效 */ }
}
export function welcomeUsed(portfolioId: number): boolean {
  try { return localStorage.getItem(usedKey(portfolioId)) === '1'; } catch { return false; }
}

// ---- 錢已經記成投入、配置還沒做完 ----

/**
 * 迎新或每日領取已經記成這檔的投入，但後面的授權或配置沒做完：記下來，下一次按鈕是「把它買完」，
 * 不再領新的錢（以前會用「總值大於 0」判斷改領每日，結果遇到 429 就卡住，或迎新後多領一筆 1,000）。
 */
const resumeKey = (portfolioId: number) => `cre8.buy-resume.${portfolioId}`;
export function rememberResume(portfolioId: number): void {
  try { localStorage.setItem(resumeKey(portfolioId), '1'); } catch { /* 只在這次造訪有效 */ }
}
export function needsResume(portfolioId: number): boolean {
  try { return localStorage.getItem(resumeKey(portfolioId)) === '1'; } catch { return false; }
}
export function forgetResume(portfolioId: number): void {
  try { localStorage.removeItem(resumeKey(portfolioId)); } catch { /* 沒有就算了 */ }
}

/**
 * 測試網買入按鈕這一次做什麼（純函式，畫面與流程共用）：
 *   - `resume`：上次的錢已經記成投入、還沒買完 → 只做授權與配置，不領新的錢。
 *   - `welcome`：還沒確定迎新用掉 → 先問 buy-funding（202 之後再按也是這條：對帳原來那筆）。
 *   - `daily`：已經確定迎新用掉（後端說要改領每日，或迎新已在這檔記過）→ 仍先問 buy-funding，再領每日 1,000。
 * 不看帳戶總值：總值大於 0 不代表迎新用掉，也不代表配置做完。
 */
export type FaucetBuyMode = 'resume' | 'welcome' | 'daily';
export function faucetBuyMode(input: { resume: boolean; welcomePending: boolean; welcomeUsed: boolean }): FaucetBuyMode {
  if (input.resume) return 'resume';
  if (input.welcomePending) return 'welcome';
  return input.welcomeUsed ? 'daily' : 'welcome';
}

/**
 * buy-funding 回 ready 之後怎麼走：
 *   - `invest`：這次有新的迎新（或 202 那筆終於到了）→ 用它買。
 *   - `daily`：迎新之前就記過了 → 要買就領每日 1,000。
 *   - `existing`：舊後端的 `existing_cash`（帳戶本來有錢，沒發迎新）→ 用帳戶裡的現金往下做。
 */
export function afterBuyFunding(
  funding: { funding: 'welcome_grant' | 'existing_cash'; lot: { replayed?: boolean } | null },
  waitingForWelcome: boolean,
): 'invest' | 'daily' | 'existing' {
  if (funding.funding === 'existing_cash') return 'existing';
  if (funding.lot === null) return 'daily';
  if (funding.lot.replayed !== true || waitingForWelcome) return 'invest';
  return 'daily';
}
