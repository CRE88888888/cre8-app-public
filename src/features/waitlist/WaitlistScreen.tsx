import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { ApiError, postWaitlistJoin } from '../../lib/api';
import { CRE8_X_HANDLE, FOLLOW_CRE8_URL, WAITLIST_LOCKED, gateView, isLandingHost, isUngatedPath, parseWaitlist, type GateView } from '../../lib/waitlist';
import { PRIVY_ENABLED } from '../../lib/privy-config';
import { usePrivyAuth } from '../../store/privy';

/**
 * 問後端「這個 X 帳號放行了沒」。連上 X、拿到 identity token 才問；還沒放行每分鐘再問一次，放行了就不再問。
 */
export function useWaitlistGate(): { view: GateView; handle: string | null; avatarUrl: string | null } {
  const { phase, methods, profile, identityToken } = usePrivyAuth();
  const hasX = methods.some((method) => method.kind === 'x');
  const query = useQuery({
    queryKey: ['waitlist', identityToken],
    queryFn: ({ signal }) => postWaitlistJoin(identityToken as string, signal).then(parseWaitlist),
    enabled: WAITLIST_LOCKED && hasX && identityToken !== null,
    // 409（沒有 X、這個 X 已被別人用）重試也一樣，不重試。
    retry: (count, error) => !(error instanceof ApiError && error.status === 409) && count < 1,
    staleTime: 30_000,
    refetchInterval: (state) => (state.state.data?.status === 'approved' ? false : 60_000),
  });
  const record = query.data ?? null;
  const checking = hasX && record === null && (identityToken === null || query.isFetching);
  const errorCode = query.error instanceof ApiError && query.error.status === 409 ? query.error.code : null;
  return { view: gateView({ phase, hasX, record, checking, errorCode }), handle: record?.xHandle ?? profile.handle, avatarUrl: profile.avatarUrl };
}

function XMark(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function FollowButton(): ReactNode {
  return (
    <a className="btn ghost block" data-method="follow" href={FOLLOW_CRE8_URL} target="_blank" rel="noopener noreferrer">
      <XMark /> Follow @{CRE8_X_HANDLE} on X
    </a>
  );
}

/**
 * 整站鎖住時唯一的畫面（使用者 2026-11-16：只有 Connect X 與 Follow @CRE8Finance on X）。
 * 樣子是 iOS 的歡迎頁：淺灰背景、大圓角 app icon、大標題、底部兩顆膠囊按鈕（X 黑底、Follow 淺灰），沿用登入頁的按鈕樣式。
 */
export function WaitlistScreen({ view, handle, avatarUrl }: { view: GateView; handle: string | null; avatarUrl: string | null }): ReactNode {
  const actions = usePrivyAuth((state) => state.actions);
  const oauthError = usePrivyAuth((state) => state.oauthError);
  const connect = (): void => void actions?.loginWithOAuth('twitter');
  const switchToX = async (): Promise<void> => {
    await actions?.logout();
    await actions?.loginWithOAuth('twitter');
  };

  const waiting = view === 'waiting' || view === 'checking';
  return (
    <div className="signin-screen waitlist" data-view={view} role="main" aria-labelledby="waitlist-title">
      <div className="waitlist__body">
        <header className="waitlist__head">
          {waiting && avatarUrl !== null ? (
            <img className="waitlist__avatar" src={avatarUrl} alt="" width={88} height={88} />
          ) : (
            <img className="waitlist__icon" src="/logos/cre8-icon.svg" alt="CRE8" width={88} height={88} />
          )}
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
        </header>
      </div>
      <div className="signin-screen__options waitlist__actions">
        {(view === 'connect' || view === 'loading') && (
          <button type="button" className="btn block" data-method="x" disabled={actions === null || view === 'loading'} onClick={connect}>
            <XMark /> Connect X
          </button>
        )}
        {view === 'switch-to-x' && (
          <button type="button" className="btn block" data-method="x" disabled={actions === null} onClick={() => void switchToX()}>
            <XMark /> Connect X
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
      </div>
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
  return <WaitlistScreen view={view} handle={gate.handle} avatarUrl={gate.avatarUrl} />;
}
