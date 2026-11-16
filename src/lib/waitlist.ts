/**
 * Waitlist（使用者 2026-11-16 決定）：整站先鎖住，進來只看到「Connect X」與「Follow @CRE8Finance on X」。
 *
 * 流程：進站 → Connect X（Privy 的 X 登入）→ 後端名單說放行就進去、沒放行就顯示排隊中。
 * 放行後：cre8.finance 看 landing；從 landing 進 tst.cre8.finance 用完整 app。
 * 名單與放行在後端（`POST /waitlist/join`，營運在 /operator 放行）；後端不通時一律當成還在排隊，整站保持鎖著。
 * 這是畫面上的鎖：真正擋住交易與資料的是後端（session、放行名單）。
 *
 * 純邏輯：不碰 React、不碰 fetch。
 */
import type { PrivyPhase } from '../store/privy';

/** 這個 build 要不要鎖（`.env.production` 的 `VITE_WAITLIST=1`；本機開發不鎖）。 */
export const WAITLIST_LOCKED = readWaitlistFlag(import.meta.env.VITE_WAITLIST);

export function readWaitlistFlag(value: unknown): boolean {
  return value === '1' || value === 'true';
}

/** CRE8 官方 X 帳號。 */
export const CRE8_X_HANDLE = 'CRE8Finance';

/**
 * 邀請碼（使用者 2026-11-16）：營運頁產生一批碼發出去，輸入正確的碼直接放行。後端還沒做（要記得誰發了幾個給誰、
 * 誰用掉了），所以預設關閉；後端上線後在 .env.production 設 `VITE_INVITES=1` 打開輸入欄。
 */
export const INVITES_OPEN = readWaitlistFlag(import.meta.env.VITE_INVITES);

/** 邀請碼的寫法：去掉前後空白、轉大寫；只收英數與連字號，4–32 個字。不合格回 null。 */
export function normalizeInviteCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9-]{4,32}$/.test(code) ? code : null;
}

const PENDING_INVITE = 'cre8.waitlist.invite';

/** 輸入了碼但還沒連 X：先記在這個分頁，連好 X 回來再用。 */
export function savePendingInvite(code: string, storage: Pick<Storage, 'setItem'> | null = safeSession()): void {
  try { storage?.setItem(PENDING_INVITE, code); } catch { /* 無痕模式寫不進去：回來後就照一般排隊 */ }
}
export function takePendingInvite(storage: Pick<Storage, 'getItem' | 'removeItem'> | null = safeSession()): string | null {
  try {
    const code = storage?.getItem(PENDING_INVITE) ?? null;
    storage?.removeItem(PENDING_INVITE);
    return code === null ? null : normalizeInviteCode(code);
  } catch {
    return null;
  }
}
function safeSession(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

/** 後端說「碼本身不能用」的代碼（backend#131）：這些改走一般排隊；其他錯誤（限流、網路、伺服器）照常重試。 */
export const INVITE_REJECTIONS: readonly string[] = ['INVITE_INVALID', 'INVITE_USED', 'INVITE_EXPIRED', 'ALREADY_APPROVED'];

/** 用碼失敗時給人看的一句話（碼錯、用過、過期都一樣，不透露是哪一種）。 */
export const INVITE_FAILED_NOTE = 'That invite code didn’t work, so you joined the waitlist instead.';
/** 「Follow」按鈕：打開 X 的追蹤確認頁。 */
export const FOLLOW_CRE8_URL = `https://x.com/intent/follow?screen_name=${CRE8_X_HANDLE}`;

/** 看 landing 的網域（其餘網域是 app，例如 tst.cre8.finance）。 */
export const LANDING_HOSTS: readonly string[] = ['cre8.finance', 'www.cre8.finance'];
/** app 所在的網域：landing 上的 app 連結都導到這裡。 */
export const APP_ORIGIN = 'https://tst.cre8.finance';

export function isLandingHost(host: string): boolean {
  return LANDING_HOSTS.includes(host.toLowerCase());
}

/** 不經過 waitlist 的頁面：營運後台（它自己要營運帳號，放行名單也在這裡操作）。 */
export function isUngatedPath(pathname: string): boolean {
  return pathname === '/operator' || pathname.startsWith('/operator/');
}

export type WaitlistStatus = 'waiting' | 'approved';
export type WaitlistRecord = { status: WaitlistStatus; xHandle: string | null; joinedAt: string | null };

/** 後端回應形狀不對就當沒有（畫面維持排隊中，不會誤放行）。 */
export function parseWaitlist(body: unknown): WaitlistRecord | null {
  if (typeof body !== 'object' || body === null) return null;
  const { status, xHandle, joinedAt } = body as Record<string, unknown>;
  if (status !== 'waiting' && status !== 'approved') return null;
  return {
    status,
    xHandle: typeof xHandle === 'string' && xHandle !== '' ? xHandle.replace(/^@/, '') : null,
    joinedAt: typeof joinedAt === 'string' ? joinedAt : null,
  };
}

export type GateView =
  /** Privy 還在載入。 */
  | 'loading'
  /** 還沒登入：顯示 Connect X。 */
  | 'connect'
  /** 用別的方式登入了、沒有 X：要換成 X。 */
  | 'switch-to-x'
  /** 已連 X，在問後端名單。 */
  | 'checking'
  /** 已連 X、還沒放行（或後端不通）。 */
  | 'waiting'
  /** 這個 X 帳號已經被另一個登入方式拿去排隊了（後端 409 X_ALREADY_JOINED）。 */
  | 'x-taken'
  | 'approved'
  /** 登入功能載不起來。 */
  | 'unavailable';

/**
 * 該顯示哪一個畫面。只有後端明確回 `approved` 才放行；後端失敗、還沒回、形狀不對都不放行。
 * Privy 換 CRE8 session 失敗（`error`，例如預覽站的 /api 回 PREVIEW_ONLY）不影響 waitlist：已連上 X 就算加入。
 */
export function gateView(input: { phase: PrivyPhase; hasX: boolean; record: WaitlistRecord | null; checking: boolean; errorCode?: string | null }): GateView {
  const { phase, hasX, record, checking, errorCode = null } = input;
  if (phase === 'unavailable') return 'unavailable';
  if (phase === 'loading') return 'loading';
  if (phase === 'signed-out') return 'connect';
  if (!hasX || errorCode === 'X_REQUIRED') return 'switch-to-x';
  if (errorCode === 'X_ALREADY_JOINED') return 'x-taken';
  if (record?.status === 'approved') return 'approved';
  if (record === null && checking) return 'checking';
  return 'waiting';
}
