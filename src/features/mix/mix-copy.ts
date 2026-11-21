/**
 * My mix 畫面上的英文（cre8-app#132）。
 *
 * 不用 rebalance、drift、bps、TP/SL、import、enroll、strategy 這些字（`tests/mix-copy.test.ts` 會檢查），
 * 改說 Auto-balance、Exit、Get this mix、My mix。錯誤一律一句白話，並說下一步怎麼做。
 *
 * 後端的 `message` 是中文；App 全英文，所以事件與狀態依 `kind`／欄位自己寫。後端若之後改給英文
 * （沒有中日韓字元），就直接用後端那句，因為它帶金額與代號、比我們的通用句具體。
 */
import type { Frequency, MixDetail, MixEventKind } from './mix-types';
import { formatReturnBps, formatUsdt, shortDate, untilLabel } from './mix-math';

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every quarter',
};

const EVENT_FALLBACK: Record<MixEventKind, string> = {
  mix_enrolled: 'Mix created and bought.',
  mix_allocation_changed: 'New mix is in effect.',
  mix_rebalanced: 'Auto-balanced back to your mix.',
  mix_switch_residual: 'A few cents of an old pick were too small to sell and stay in your account.',
  mix_exit_triggered: 'Exit reached. Selling everything for USDT.',
  mix_exit_stuck: 'Selling is taking longer than usual. We keep trying.',
};

const CJK = /[　-鿿＀-￯]/;

export function eventText(event: { kind: MixEventKind; message: string }): string {
  const message = event.message.trim();
  return message !== '' && !CJK.test(message) ? message : EVENT_FALLBACK[event.kind];
}

/** 收盤時 Buy 按鈕上面那一句。全部開市回 null。 */
export function marketNote(
  markets: readonly { open: boolean; nextOpenAt: string | null }[],
  hasCrypto: boolean,
  now: Date = new Date(),
): string | null {
  const closed = markets.filter((market) => !market.open);
  if (closed.length === 0) return null;
  const next = closed.map((market) => market.nextOpenAt).filter((at): at is string => at !== null).sort()[0];
  const when = next === undefined ? 'when the US market opens' : `when the US market opens in ${untilLabel(next, now)}`;
  return hasCrypto ? `Crypto buys now. Stocks buy ${when}.` : `Stocks buy ${when}.`;
}

/** 觸發 Exit 之後頁面最上面那一句。 */
export function exitedText(mix: Pick<MixDetail, 'returnBps' | 'currentValueRaw' | 'events'>): string {
  const at = mix.events.find((event) => event.kind === 'mix_exit_triggered')?.at;
  const pct = formatReturnBps(mix.returnBps);
  const amount = mix.currentValueRaw === null ? null : formatUsdt(mix.currentValueRaw);
  const head = pct === null ? 'Sold everything' : `Sold everything at ${pct}`;
  return `${head}${at === undefined ? '' : ` on ${shortDate(at)}`}.${amount === null ? '' : ` ${amount} USDT is in your account.`}`;
}


/** 錢已經進組合帳戶，但還沒記成這個組合的投入（組合頁打開時會補記）。 */
export const FUNDING_NOT_RECORDED = 'Your USDT is in your mix. We start buying once it is recorded. Open this mix again in a minute.';

/** 後端錯誤碼 → 一句白話＋下一步。沒列到的給通用句（後端的 `message` 是中文，不直接顯示）。 */
export function errorText(code: string | undefined): string {
  switch (code) {
    case 'INVALID_MIX':
    case 'INVALID_MIX_ASSETS':
    case 'INVALID_MIX_ASSET':
    case 'INVALID_MIX_PREVIEW':
    case 'TOO_MANY_ASSETS':
      return 'Pick between 1 and 10 to continue.';
    case 'INVALID_MIX_WEIGHT':
    case 'INVALID_MIX_TOTAL':
      return 'Each pick needs at least 1%, and they need to add up to 100%. Adjust and try again.';
    case 'INVALID_MIX_NAME':
      return 'That name is too long. Use up to 100 letters.';
    case 'INVALID_MIX_FREQUENCY':
      return 'Pick how often we balance: every day, week, month or quarter.';
    case 'INVALID_MIX_DATE':
      return 'Pick a start date from today on.';
    case 'INVALID_MIX_EXIT':
      return 'Pick a different sell point. Up can be any number, down must be under 100%.';
    case 'MIX_BUSY':
    case 'MIX_CREATE_BUSY':
    case 'MIX_PREVIEW_BUSY':
    case 'MIX_SWITCH_PENDING':
      return 'We are still finishing your last change. Try again in a minute.';
    case 'BELOW_MINIMUM_ALLOCATION':
      return 'That is below the minimum for this mix. Add a bigger amount.';
    case 'RATE_LIMITED':
      return 'Too many tries in a short time. Wait a few minutes and try again.';
    case 'MIX_REQUEST_CONFLICT':
      return 'This page changed while you were buying. Go back, check your mix, and buy again.';
    case 'MIX_NOT_FOUND':
    case 'INVALID_MIX_IMPORT':
      return 'This mix is no longer available. Build your own instead.';
    case 'MIX_NOT_EXITED':
      return 'This mix is still selling. Try again after it is done.';
    case 'MIX_NO_PENDING_CHANGE':
      return 'Nothing is waiting for your signature. Refresh the page.';
    case 'MIX_ASSET_LIMIT':
      return 'Some old picks are still being sold. Try this change again after they are sold.';
    case 'MIX_CHAIN_UNAVAILABLE':
      return 'My mix is only on testnet for now.';
    case 'UNAUTHORIZED':
      return 'Your sign-in expired. Sign in again to continue.';
    case 'MIX_PAYLOAD_INVALID':
      return 'Our server sent something we could not check, so nothing was signed or sent. Try again in a minute.';
    case 'MIX_SIGNED_REVERTED':
      return 'The network rejected this change, so nothing changed. Try again in a minute.';
    case 'MIX_TRANSFER_REVERTED':
      return 'The transfer did not go through, so no USDT moved. Try again in a minute.';
    case 'USER_REJECTED':
      return 'You cancelled in your wallet. Nothing was sent.';
    case 'NETWORK':
    case 'MIX_PREVIEW_TIMEOUT':
    case 'MIX_PREVIEW_UNAVAILABLE':
    case 'MIX_UNAVAILABLE':
    case 'MIX_HISTORY_UNAVAILABLE':
      return 'We could not reach our server. Check your connection and try again.';
    default:
      return 'Something went wrong on our side. Try again in a minute.';
  }
}

/** 任何錯誤 → 一句白話。已經是英文白話的（水龍頭、補手續費）照用；錢包拒簽另外講。 */
export function mixErrorText(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown } | null;
  if (e === null || typeof e !== 'object') return errorText(undefined);
  if (e.code === 'MIX_FAUCET_FAILED' && typeof e.message === 'string') return e.message;
  if (e.name === 'OwnerGasError' && typeof e.message === 'string') return e.message;
  if (isUserRejection(e)) return errorText('USER_REJECTED');
  if (e.name === 'AccountNotReadyError' || e.name === 'AccountNotDeployedError') return 'Your mix account is still being set up. Try again in a minute.';
  if (e.name === 'SponsorshipError') return 'We could not cover the network fee right now, so nothing was sent. Try again in a minute.';
  return errorText(typeof e.code === 'string' ? e.code : undefined);
}

function isUserRejection(e: { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }): boolean {
  for (let current: typeof e | undefined = e, depth = 0; current && depth < 5; current = current.cause as typeof e | undefined, depth += 1) {
    if (current.code === 4001 || current.name === 'UserRejectedRequestError') return true;
    if (typeof current.message === 'string' && /user (rejected|denied)/i.test(current.message)) return true;
  }
  return false;
}
