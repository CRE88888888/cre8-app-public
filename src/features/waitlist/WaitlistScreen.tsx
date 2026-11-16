import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, postWaitlistJoin, postWaitlistRedeem } from '../../lib/api';
import {
  CRE8_X_HANDLE, FOLLOW_CRE8_URL, INVITES_OPEN, INVITE_FAILED_NOTE, INVITE_REJECTIONS, WAITLIST_LOCKED, gateView, isLandingHost, isUngatedPath,
  normalizeInviteCode, parseWaitlist, savePendingInvite, takePendingInvite, type GateView, type WaitlistRecord,
} from '../../lib/waitlist';
import { PRIVY_ENABLED } from '../../lib/privy-config';
import { useMobile } from '../../lib/use-mobile';
import { usePrivyAuth } from '../../store/privy';
import { FlapBoard } from './FlapBoard';

/**
 * 加入或用碼加入：連 X 之前輸入過邀請碼（`INVITES_OPEN` 時），先用碼；碼本身不能用（`INVITE_REJECTIONS`）就照一般排隊，
 * 並記下要提示（已經放行的人 ALREADY_APPROVED 走排隊也會是 approved，不顯示提示）。其他錯誤（429、網路、伺服器、
 * 沒有 X）照常丟出去，並用 `keep` 把碼放回去，重試時還會用到。
 */
export async function joinWaitlist(
  identityToken: string,
  pendingCode: string | null,
  deps: { join?: typeof postWaitlistJoin; redeem?: typeof postWaitlistRedeem; keep?: (code: string) => void; signal?: AbortSignal } = {},
): Promise<{ record: WaitlistRecord | null; inviteFailed: boolean }> {
  const { join = postWaitlistJoin, redeem = postWaitlistRedeem, keep = () => {}, signal } = deps;
  if (pendingCode !== null) {
    try {
      return { record: parseWaitlist(await redeem(identityToken, pendingCode, signal)), inviteFailed: false };
    } catch (cause) {
      if (!(cause instanceof ApiError) || !INVITE_REJECTIONS.includes(cause.code)) {
        keep(pendingCode);
        throw cause;
      }
      const record = parseWaitlist(await join(identityToken, signal));
      return { record, inviteFailed: cause.code !== 'ALREADY_APPROVED' };
    }
  }
  return { record: parseWaitlist(await join(identityToken, signal)), inviteFailed: false };
}

/**
 * 問後端「這個 X 帳號放行了沒」。連上 X、拿到 identity token 才問；還沒放行每分鐘再問一次，放行了就不再問。
 */
export function useWaitlistGate(): { view: GateView; handle: string | null; avatarUrl: string | null; inviteFailed: boolean } {
  const { phase, methods, profile, identityToken } = usePrivyAuth();
  const hasX = methods.some((method) => method.kind === 'x');
  const query = useQuery({
    queryKey: ['waitlist', identityToken],
    queryFn: ({ signal }) => joinWaitlist(identityToken as string, INVITES_OPEN ? takePendingInvite() : null, { signal, keep: savePendingInvite }),
    enabled: WAITLIST_LOCKED && hasX && identityToken !== null,
    // 409（沒有 X、這個 X 已被別人用）重試也一樣，不重試。
    retry: (count, error) => !(error instanceof ApiError && error.status === 409) && count < 1,
    staleTime: 30_000,
    refetchInterval: (state) => (state.state.data?.record?.status === 'approved' ? false : 60_000),
  });
  const record = query.data?.record ?? null;
  const checking = hasX && record === null && (identityToken === null || query.isFetching);
  const errorCode = query.error instanceof ApiError && query.error.status === 409 ? query.error.code : null;
  return { view: gateView({ phase, hasX, record, checking, errorCode }), handle: record?.xHandle ?? profile.handle, avatarUrl: profile.avatarUrl, inviteFailed: query.data?.inviteFailed ?? false };
}

function XMark(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** 開新分頁的箭頭（↗）。 */
function ArrowOut(): ReactNode {
  return (
    <svg className="waitlist__arrow" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

function FollowButton(): ReactNode {
  return (
    // 「on X」的 X 也直接用 logo（使用者 2026-11-16），報讀器念完整的句子。
    <a className="btn ghost block" data-method="follow" href={FOLLOW_CRE8_URL} target="_blank" rel="noopener noreferrer" aria-label={`Follow @${CRE8_X_HANDLE} on X (opens X)`}>
      Follow @{CRE8_X_HANDLE} on <XMark /> <ArrowOut />
    </a>
  );
}

/** Connect 按鈕：X 直接用 logo（「Connect 𝕏」），不要同一顆按鈕裡出現兩個 X。報讀器念「Connect X」。 */
function ConnectLabel(): ReactNode {
  return <>Connect <XMark /></>;
}

/** 邀請碼輸入欄（`INVITES_OPEN` 時）：先記下碼，再連 X；連好回來用碼加入（`joinWaitlist`）。 */
function InviteCode({ onSubmit, disabled }: { onSubmit: (code: string) => void; disabled: boolean }): ReactNode {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const code = normalizeInviteCode(text);
    setInvalid(code === null);
    if (code !== null) onSubmit(code);
  };
  return (
    <form className="waitlist__invite" onSubmit={submit}>
      <label htmlFor="waitlist-invite">Have an invite code?</label>
      <div className="waitlist__invite-row">
        <input
          id="waitlist-invite" name="invite" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="Invite code"
          value={text} aria-invalid={invalid || undefined} aria-describedby={invalid ? 'waitlist-invite-error' : undefined}
          onChange={(event) => { setText(event.target.value); setInvalid(false); }}
        />
        <button type="submit" className="btn" disabled={disabled || text.trim() === ''}>Use code</button>
      </div>
      {invalid && <p id="waitlist-invite-error" className="signin-screen__error" role="alert">Check the code: letters, numbers and dashes only.</p>}
    </form>
  );
}

/**
 * 整站鎖住時唯一的畫面（使用者 2026-11-16）。左邊是表單（Connect X、Follow；後端開了之後還有邀請碼），
 * 右邊是淺色的翻牌看板（FlapBoard，跟翻牌 8 logo 同一套語言）。手機上看板縮成三排放在上面。
 */
export function WaitlistScreen({ view, handle, avatarUrl, inviteFailed = false }: { view: GateView; handle: string | null; avatarUrl: string | null; inviteFailed?: boolean }): ReactNode {
  const actions = usePrivyAuth((state) => state.actions);
  const oauthError = usePrivyAuth((state) => state.oauthError);
  const mobile = useMobile();
  const connect = (): void => void actions?.loginWithOAuth('twitter');
  const switchToX = async (): Promise<void> => {
    await actions?.logout();
    await actions?.loginWithOAuth('twitter');
  };
  const useCode = (code: string): void => {
    savePendingInvite(code);
    if (view === 'switch-to-x') void switchToX();
    else connect();
  };

  const waiting = view === 'waiting' || view === 'checking';
  return (
    <div className="signin-screen waitlist" data-view={view} role="main" aria-labelledby="waitlist-title">
      <section className="waitlist__panel">
        <div className="waitlist__brand">
          <img src="/logos/cre8-icon.svg" alt="" width={32} height={32} />
          <span>CRE8</span>
        </div>
        <div className="waitlist__body">
          <header className="waitlist__head">
            {waiting && avatarUrl !== null && <img className="waitlist__avatar" src={avatarUrl} alt="" width={64} height={64} />}
            <h1 id="waitlist-title">
              {view === 'checking' ? 'Checking your spot…' : waiting ? 'You’re on the list' : view === 'switch-to-x' ? 'Connect X to join' : view === 'x-taken' ? 'This X account is already on the list' : 'CRE8 is invite-only'}
            </h1>
            <p>
              {view === 'checking'
                ? 'One moment.'
                : waiting
                  ? <>{handle !== null && <b>@{handle} · </b>}Follow @{CRE8_X_HANDLE} to hear when your spot opens.</>
                  : view === 'switch-to-x'
                    ? 'The waitlist uses your X account. Connect X to save your spot.'
                    : view === 'x-taken'
                      ? <>{handle !== null && <b>@{handle} · </b>}It joined with a different sign-in. Sign in the way you did before, or use another X account.</>
                    : view === 'unavailable'
                      ? 'Sign-in isn’t available right now. Please try again in a moment.'
                      : 'Connect your X account to join the waitlist.'}
            </p>
            {waiting && inviteFailed && <p className="waitlist__notice" role="status">{INVITE_FAILED_NOTE}</p>}
          </header>
          <div className="signin-screen__options waitlist__actions">
            {(view === 'connect' || view === 'loading') && (
              <button type="button" className="btn block" data-method="x" aria-label="Connect X" disabled={actions === null || view === 'loading'} onClick={connect}>
                <ConnectLabel />
              </button>
            )}
            {view === 'switch-to-x' && (
              <button type="button" className="btn block" data-method="x" aria-label="Connect X" disabled={actions === null} onClick={() => void switchToX()}>
                <ConnectLabel />
              </button>
            )}
            <FollowButton />
            {oauthError !== null && oauthError !== undefined && (view === 'connect' || view === 'switch-to-x') && (
              <p className="signin-screen__error" role="alert">X sign-in could not be started. Please try again.</p>
            )}
            {(waiting || view === 'x-taken') && (
              <button type="button" className="signin-screen__text" onClick={() => void switchToX()}>
                Use a different X account
              </button>
            )}
            {INVITES_OPEN && (view === 'connect' || view === 'switch-to-x') && <InviteCode onSubmit={useCode} disabled={actions === null} />}
          </div>
        </div>
      </section>
      <aside className="waitlist__board" aria-label="CRE8 board">
        <FlapBoard rows={mobile ? 3 : 8} />
      </aside>
    </div>
  );
}

/**
 * 放行後在 landing 網域（cre8.finance）：換成 landing（`/landing/`）。app 網域（tst.cre8.finance）直接顯示 app。
 */
export function useLandingAfterApproval(view: GateView): void {
  useEffect(() => {
    if (view === 'approved' && isLandingHost(window.location.hostname) && window.location.pathname === '/') {
      window.location.replace('/landing/');
    }
  }, [view]);
}

/**
 * 整站的 waitlist 閘門（`VITE_WAITLIST=1`）：沒放行就只顯示 WaitlistScreen；放行後 app 網域照常顯示頁面，
 * landing 網域換成 landing。營運後台（/operator）不鎖。
 * 它是包住頁面的子元件，App 本身不訂閱登入狀態（App 重繪會連帶重繪 PrivyRoot，造成無限迴圈）。
 */
export function WaitlistGate({ children }: { children: ReactNode }): ReactNode {
  const gate = useWaitlistGate();
  const view: GateView = PRIVY_ENABLED ? gate.view : 'unavailable';
  useLandingAfterApproval(WAITLIST_LOCKED ? view : 'loading');
  if (!WAITLIST_LOCKED || isUngatedPath(window.location.pathname)) return children;
  if (view === 'approved') return isLandingHost(window.location.hostname) ? null : children;
  return <WaitlistScreen view={view} handle={gate.handle} avatarUrl={gate.avatarUrl} inviteFailed={gate.inviteFailed} />;
}
