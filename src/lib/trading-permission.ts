/**
 * 交易權限（session key）的狀態判讀（cre8-app#25）。純函式：沒有 React、沒有 fetch。
 *
 * 「交易權限」＝帳戶 owner 簽名安裝在帳戶上的一把 session key，讓排程器可以替這個帳戶再平衡、
 * 賣出部位。它有到期日（365 天）；後端換 master seed 之後舊的那把也不能再用。兩種情況都要
 * owner 再簽一次（續期）才會恢復。
 *
 * 只用後端 status 已經回傳的欄位推導，不猜：讀不到就說讀不到，不當成「正常」也不當成「沒有」。
 */
import type { SessionKeyReport } from './api';

/** 剩不到這麼多天就提醒續期（與 Studio 的「Renew in Nd」同一個門檻）。 */
export const RENEW_SOON_DAYS = 7;

const DAY_MS = 86_400_000;

export type PermissionState = 'active' | 'expiring' | 'expired' | 'missing' | 'unknown';

export type PermissionHealth = {
  state: PermissionState;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  /** 徽章上的短字。 */
  label: string;
  /** 一句話：現在怎麼了、使用者要不要做什麼。 */
  detail: string;
  expiresAt: string | null;
  /** 距離到期還有幾天（無條件進位，最少 0）。沒有到期日時為 null。 */
  daysLeft: number | null;
  /** true = 不續期的話再平衡與賣出會停住（或已經停住）。 */
  needsAction: boolean;
};

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function tradingPermissionHealth(
  report: SessionKeyReport | null | undefined,
  now: number = Date.now(),
): PermissionHealth {
  const unknown: PermissionHealth = {
    state: 'unknown',
    tone: 'neutral',
    label: 'Not checked',
    detail: 'The trading permission could not be read right now. Try again in a moment.',
    expiresAt: null,
    daysLeft: null,
    needsAction: false,
  };
  if (report === null || report === undefined) return unknown;

  const usable = report.usable;
  if (usable === null) {
    // `usable === null` 只有在沒有讀取錯誤時才能讀成「沒有可用的權限」。
    if (report.error !== null) return unknown;
    const configuredExpiry = report.configured?.expiresAt ?? null;
    const lapsed = configuredExpiry !== null && Date.parse(configuredExpiry) <= now;
    return lapsed
      ? {
          state: 'expired',
          tone: 'bad',
          label: 'Expired',
          detail: `The trading permission expired on ${formatDay(configuredExpiry)}. Rebalancing and selling are paused until you renew it.`,
          expiresAt: configuredExpiry,
          daysLeft: 0,
          needsAction: true,
        }
      : {
          state: 'missing',
          tone: 'bad',
          label: 'Not active',
          detail: 'This account has no active trading permission, so the fund cannot rebalance or sell. Renew it to turn trading back on.',
          expiresAt: null,
          daysLeft: null,
          needsAction: true,
        };
  }

  const expiresAt = usable.expiresAt;
  const expiry = expiresAt === null ? Number.NaN : Date.parse(expiresAt);
  if (expiresAt === null || !Number.isFinite(expiry)) {
    return {
      state: 'active',
      tone: 'ok',
      label: 'Active',
      detail: 'The fund can rebalance and sell on your behalf.',
      expiresAt: null,
      daysLeft: null,
      needsAction: false,
    };
  }
  if (expiry <= now) {
    return {
      state: 'expired',
      tone: 'bad',
      label: 'Expired',
      detail: `The trading permission expired on ${formatDay(expiresAt)}. Rebalancing and selling are paused until you renew it.`,
      expiresAt,
      daysLeft: 0,
      needsAction: true,
    };
  }
  const daysLeft = Math.max(1, Math.ceil((expiry - now) / DAY_MS));
  if (expiry - now < RENEW_SOON_DAYS * DAY_MS) {
    return {
      state: 'expiring',
      tone: 'warn',
      label: `Expires in ${daysLeft}d`,
      detail: `The trading permission expires on ${formatDay(expiresAt)}. Renew it before then so rebalancing does not stop.`,
      expiresAt,
      daysLeft,
      needsAction: true,
    };
  }
  return {
    state: 'active',
    tone: 'ok',
    label: 'Active',
    detail: `The fund can rebalance and sell on your behalf until ${formatDay(expiresAt)}.`,
    expiresAt,
    daysLeft,
    needsAction: false,
  };
}

/**
 * 賣出／清倉失敗的訊息是不是在說「交易權限不能用了」。
 *
 * 後端換 master seed 之後，status 看不出來（舊的那把在鏈上還是裝著的），只有真的要用它時
 * 才會被擋（`SESSION_KEY_DERIVATION_MISMATCH` 之類）。認出這種訊息，才能告訴使用者去續期，
 * 而不是只丟一段他看不懂的錯誤。
 */
export function isPermissionFailure(message: string): boolean {
  return /SESSION_KEY|session[\s_-]?key/i.test(message);
}

/**
 * 續期成功後顯示的話。
 *
 * ⚠ 不可以說舊的權限「已撤銷／已取代」：續期只是**多裝一把新的**，舊的那把在鏈上仍然有效到它
 * 自己的到期日。撤銷舊權限是另一件事（ROADMAP「上線後」）。
 */
export function renewedMessage(validUntilSeconds: number): string {
  const until = formatDay(new Date(validUntilSeconds * 1000).toISOString());
  return `New trading permission installed, valid until ${until}. Earlier permissions were not revoked — they stay valid on-chain until they expire.`;
}
