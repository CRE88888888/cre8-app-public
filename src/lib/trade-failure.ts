/**
 * 把後端 `/rebalance`、`/redeem`、`/close` 沒成交的結果換成使用者看得懂的英文（cre8-app#55）。
 * 純函式：沒有 React、沒有 fetch。
 *
 * 背景：這三支端點回的是 `outcome` 加一句 `reason`。`reason` 是排程器寫給營運看的內部訊息，
 * 大多是中文（例如「聚合器刷新失敗或 venue 改變，不送交易」），原樣放進英文介面使用者看不懂，
 * 畫面還會在上面冠一個「Unexpected error」。
 *
 * 後端**沒有**獨立的錯誤碼欄位。能拿來判斷的只有：
 *   1. `outcome`（blocked／failed／reverted／noop）。
 *   2. `reason` 裡夾帶的穩定標記：合約錯誤名（`ExecutorPaused`、`StaleFeed`…）與
 *      方括號代碼（`[ALLOWANCE_TOO_LOW]`、`[MAX_LEG_ZERO]`…）。
 *   3. 幾句固定的後端文字（沒有代碼的情況，例如聚合器重問失敗）。
 * 都認不出來時給通用訊息。原文一律不放進主要訊息，只由呼叫端收進可展開的詳細資訊。
 *
 * 判斷順序有意義，見 `explainTradeFailure` 裡的註解。
 */
import { explainA10Failure, type PauseSource } from './a10';
import { isPermissionFailure } from './trading-permission';

export type TradeFailureKind =
  | 'unconfirmed'
  | 'in-flight'
  | 'settled-earlier'
  | 'data-unavailable'
  | 'price-source'
  | 'platform-paused'
  | 'buy-limit'
  | 'account-paused'
  | 'quote-refresh'
  | 'price-moved'
  | 'approval'
  | 'balance-changed'
  | 'permission'
  | 'asset-disabled'
  | 'trade-limit'
  | 'no-route'
  | 'over-total'
  | 'too-small'
  | 'nothing-to-sell'
  | 'busy'
  | 'already-done'
  | 'reverted'
  | 'nothing-to-do'
  | 'not-sent';

export type TradeFailure = {
  kind: TradeFailureKind;
  /** false = 認不出原因，訊息是依 `outcome` 給的通用訊息。 */
  recognized: boolean;
  /** 發生了什麼（白話英文，不含後端原文、不含「接下來怎麼辦」）。 */
  summary: string;
  /**
   * `summary` 加上接下來怎麼辦（多半是「再試一次」）。賣出、清倉、營運端用這個。
   * 買入後的第一次配置**不要**用：那裡「再試一次」會被理解成再存一次錢，要用 `summary`。
   */
  message: string;
  /** 給可展開的詳細資訊用：`outcome` 與後端原文。後端什麼都沒給時是空字串。 */
  technical: string;
};

export type TradeFailureContext = {
  pauseSources?: readonly PauseSource[] | null;
  nextBuyAt?: number | null;
};

type CopyKind = Exclude<TradeFailureKind, 'platform-paused' | 'buy-limit' | 'account-paused'>;

/** 每一類：[發生了什麼, 接下來怎麼辦]。A10 的三類沿用 `lib/a10.ts` 的句子，不在這裡。 */
const COPY: Record<CopyKind, readonly [summary: string, next: string]> = {
  unconfirmed: [
    'A trade was submitted, but its result could not be confirmed yet.',
    'Do not retry right away — wait a minute and check your balances first.',
  ],
  'in-flight': [
    'An earlier trade for this fund is still being confirmed, so nothing new was sent.',
    'Wait a minute, then try again.',
  ],
  'settled-earlier': [
    'An earlier trade for this fund has just been settled, so no new trade was sent this time.',
    'Check your balances, then try again if you still need to.',
  ],
  'data-unavailable': [
    'The fund could not read the on-chain data it needs to trade safely, so nothing was sent and your funds did not move.',
    'Please try again in a minute.',
  ],
  'price-source': [
    'A price feed for one of the fund’s assets is out of date or disagrees with the market, so trading it is on hold. Nothing was sent and your funds did not move.',
    'Please try again later.',
  ],
  'quote-refresh': [
    'The price could not be re-confirmed just before sending, so the trade was not sent and your funds did not move.',
    'This is usually temporary — please try again.',
  ],
  'price-moved': [
    'The price moved before the trade could complete, so it was cancelled and your holdings did not change.',
    'Please try again.',
  ],
  approval: [
    'The fund is not approved to trade one of its assets yet, so nothing was sent.',
    'Open My position, approve the asset, then try again.',
  ],
  'balance-changed': [
    'The account’s balance changed while the trade was being prepared, so nothing was sent.',
    'Please try again.',
  ],
  permission: [
    'The fund’s trading permission is missing or no longer accepted, so nothing was sent and your funds did not move.',
    'Open My position and choose Renew permission, then try again.',
  ],
  'asset-disabled': [
    'Trading in one of the fund’s assets is switched off right now, so nothing was sent and your funds did not move.',
    '',
  ],
  'trade-limit': [
    'The trade could not be fitted within the per-trade size limit, so nothing was sent and your funds did not move.',
    'Please try again later.',
  ],
  'no-route': [
    'No trading route offers a safe price for this trade right now, so nothing was sent and your funds did not move.',
    'Please try again later.',
  ],
  'over-total': ['The amount is more than the fund is worth right now, so nothing was sent.', 'Enter a smaller amount.'],
  'too-small': ['The amount is too small to trade, so nothing was sent.', ''],
  'nothing-to-sell': ['There are no positions left to sell in this fund.', ''],
  busy: [
    'The fund is busy with another operation or its schedule is not active, so nothing was sent.',
    'Wait a minute, then try again.',
  ],
  'already-done': ['This exact trade already went through, so it was not sent again.', 'Check your balances.'],
  reverted: [
    'The trade reached the chain but was reverted, so your holdings did not change (only the network fee was spent).',
    'Please try again.',
  ],
  'nothing-to-do': ['Nothing needed to be traded this time.', ''],
  'not-sent': ['The trade was not sent; your funds did not move.', 'Please try again.'],
};

/** 認不出原因、也沒有送出交易時的通用訊息。 */
export const TRADE_NOT_SENT_MESSAGE = join(COPY['not-sent']);

function join(copy: readonly [string, string]): string {
  return copy[1] === '' ? copy[0] : `${copy[0]} ${copy[1]}`;
}

/** `reason` 的固定文字／標記 → 類別。由上到下比對，第一個符合的算數。 */
const PATTERNS: readonly [RegExp, CopyKind][] = [
  // 「送了但不知道結果」一定要排最前面：這時候不可以說「錢沒有動」。
  [/送出結果未知/, 'unconfirmed'],
  [/先對帳完成|安全釋放/, 'settled-earlier'],
  [/已經 confirmed 過|不重複執行/, 'already-done'],
  [/先對帳|未決操作|結果未知|還在 (pending|submitted)/, 'in-flight'],
  // 價格來源錯誤名可能出現在任何一層的訊息裡（含 `[MAX_LEG_…]` 的替代訊息），所以排在代碼之前。
  [/StaleFeed|SourcesDisagree|InvalidAnswer/, 'price-source'],
  [/聚合器刷新|聚合器.*不送交易|送出前重問地板|quote-failed/, 'quote-refresh'],
  [/BelowFloor|floor-collapsed|Too little received|INSUFFICIENT_OUTPUT_AMOUNT/, 'price-moved'],
  [/ALLOWANCE_TOO_LOW/, 'approval'],
  [/INSUFFICIENT_BALANCE/, 'balance-changed'],
  [/MAX_LEG_ZERO/, 'asset-disabled'],
  // `…_UNAVAILABLE` 是「讀不到」，不是那件事真的發生了（例如 `[BUY_ALLOWANCE_UNAVAILABLE]` 不是額度用完）。
  [/\[[A-Z_]+_UNAVAILABLE\]/, 'data-unavailable'],
  [/MAX_LEG_(ROUTE|QUOTE_INVALID)/, 'trade-limit'],
  [/NoFloor|OracleNotSet|NotNumeraireRoute|沒有符合地板|cannot quote right now/, 'no-route'],
  [/超過投組總值/, 'over-total'],
  [/待賣代幣量為 0|待賣量換算後為 0/, 'too-small'],
  [/nothing to sell|沒有非現金部位/, 'nothing-to-sell'],
  [/沒有認領/, 'busy'],
];

/**
 * 沒成交的一輪 → 類別與白話訊息。
 *
 * `outcome` 傳後端回的原值；不知道（例如只有一段錯誤文字）就不傳，當成「沒有送出」。
 * `executed` 不該進來；進來了也只會得到通用訊息，不會丟錯。
 */
export function explainTradeFailure(
  result: { outcome?: string | null; reason?: string | null },
  context: TradeFailureContext = {},
): TradeFailure {
  const outcome = result.outcome ?? null;
  const reason = (result.reason ?? '').trim();
  const technical = [outcome === null ? null : `outcome: ${outcome}`, reason === '' ? null : reason]
    .filter((line): line is string => line !== null)
    .join('\n');
  const fromCopy = (kind: CopyKind, recognized: boolean): TradeFailure => ({
    kind,
    recognized,
    summary: COPY[kind][0],
    message: join(COPY[kind]),
    technical,
  });
  // A10 的句子本身就同時講了「怎麼了」與「可以做什麼」（例如「賣出與提領仍可用」），不拆。
  const fromA10 = (kind: TradeFailureKind, sentence: string): TradeFailure => ({
    kind,
    recognized: true,
    summary: sentence,
    message: sentence,
    technical,
  });

  // 順序：
  //   1. 固定文字／代碼裡排在 A10 之前的那幾類（結果不明、價格來源、讀不到資料）。
  //      `[EXECUTOR_PAUSE_UNAVAILABLE]`、`[BUY_ALLOWANCE_UNAVAILABLE]` 字面上含有 A10 的關鍵字，
  //      先比 A10 會把「讀不到」說成「已暫停／額度用完」。
  //   2. A10（平台暫停、買入額度、帳戶暫停）：沿用 `explainA10Failure`，它會帶暫停來源與下次買入時間。
  //   3. 交易權限（session key）。排在其餘代碼之前：前置檢查會把好幾個代碼串在同一句裡，
  //      權限沒了是最根本的那一個。
  //   4. 其餘固定文字／代碼。
  //   5. 都認不出來 → 依 outcome 給通用訊息。
  const early = matchPattern(reason, EARLY_KINDS);
  if (early !== null) return fromCopy(early, true);

  const a10 = explainA10Failure(reason, context);
  if (a10 !== null) return fromA10(a10Kind(reason), a10);
  if (/enrollment 是 paused/.test(reason)) {
    const sentence = explainA10Failure('Paused()', context);
    if (sentence !== null) return fromA10('account-paused', sentence);
  }

  if (isPermissionFailure(reason)) return fromCopy('permission', true);
  const later = matchPattern(reason);
  if (later !== null) return fromCopy(later, true);

  return fromCopy(outcome === 'reverted' ? 'reverted' : outcome === 'noop' ? 'nothing-to-do' : 'not-sent', false);
}

const EARLY_KINDS: readonly CopyKind[] = ['unconfirmed', 'settled-earlier', 'already-done', 'in-flight', 'price-source', 'data-unavailable'];

function matchPattern(reason: string, only?: readonly CopyKind[]): CopyKind | null {
  for (const [pattern, kind] of PATTERNS) {
    if (only !== undefined && !only.includes(kind)) continue;
    if (pattern.test(reason)) return kind;
  }
  return null;
}

/** `explainA10Failure` 認得的三種；比對順序與它一致。 */
function a10Kind(reason: string): TradeFailureKind {
  if (/ExecutorPaused|EXECUTOR_PAUSE|全域暫停/.test(reason)) return 'platform-paused';
  if (/BuyLimitExceeded|BUY_ALLOWANCE|買入額度/.test(reason)) return 'buy-limit';
  return 'account-paused';
}

/**
 * 沒成交時丟給畫面的錯誤：`message` 是白話英文，後端原文在 `technical`。
 * `ErrorNote` 認得它，會把原文收進可展開的「Technical details」，不顯示「Unexpected error」。
 */
export class TradeFailureError extends Error {
  readonly kind: TradeFailureKind;
  readonly technical: string;
  /** 錯誤區塊的標題（例如「Sale not completed」）。 */
  readonly title: string;
  constructor(failure: TradeFailure, options: { title: string; message?: string }) {
    super(options.message ?? failure.message);
    this.name = 'TradeFailureError';
    this.kind = failure.kind;
    this.technical = failure.technical;
    this.title = options.title;
  }
}
