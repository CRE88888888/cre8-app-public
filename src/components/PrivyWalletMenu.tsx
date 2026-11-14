import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { shortAddress } from '../lib/format';
import { explainPrivyLoginFailure, linkableMethods, readOnlyNotice, signInMethodName } from '../lib/privy-owner';
import { useConnectedSessionToken } from '../lib/use-connected-session';
import { openSignIn, usePrivyAuth } from '../store/privy';
import { useSession } from '../store/session';
import { AppIcon } from './AppIcon';
import { Note, TechnicalDetails } from './ui';

/**
 * Privy 模式的登入選單（cre8-app#57）。`VITE_PRIVY_APP_ID` 有設定時取代原本的錢包選單，
 * 位置、按鈕樣式與 props 都一樣（標頭、手機工具列、頁面內的 `inline`）。
 *
 * 這個元件不 import Privy SDK：狀態與動作來自 `usePrivyAuth`（由 `PrivyRoot` 同步）。
 *
 * - 還沒登入：按鈕打開我們自己的登入頁（`SignInScreen`：Google／Apple／email／錢包）。
 * - 登入中、換 session 失敗、已登入：按鈕打開選單。
 * - 已登入的選單：主人地址、已綁的登入方式、加綁、匯出私鑰（嵌入式錢包）、登出。
 *   **加綁只在已經有 CRE8 session 時出現**：首次登入前綁了別的錢包，後端就認不出誰是主人（backend#63）。
 *
 * 樣式與互動都沿用原本的錢包選單，不另外發明：每個動作是一整列靠左的 `.wallet-menu__item`；
 * 「Add a sign-in method」跟原選單的「Browser wallets」一樣，點了才在下面展開選項；
 * 主要按鈕是 `.btn.sm`，次要的是底線文字 `.wallet-menu__link`。
 */
export function PrivyWalletMenu({ inline = false, showIcon = false, iconOnly = false, openEvent }: {
  inline?: boolean;
  showIcon?: boolean;
  iconOnly?: boolean;
  /** 別的元件叫出登入用的事件名（`OPEN_WALLET_MENU`）。 */
  openEvent: string;
}): ReactNode {
  const { phase, error, methods, ownerEmbedded, signer, actions } = usePrivyAuth();
  const token = useConnectedSessionToken();
  const owner = useSession((state) => state.address);
  const signedIn = token !== null && owner !== null;
  const busy = !signedIn && (phase === 'creating-wallet' || phase === 'exchanging');
  const failed = !signedIn && phase === 'error';
  /** SDK 載不下來、初始化失敗，或按了登入卻等太久：講清楚，不要讓按鈕一直轉。 */
  const [stalled, setStalled] = useState(false);
  const unavailable = !signedIn && (phase === 'unavailable' || (stalled && phase === 'loading'));

  const [open, setOpen] = useState(false);
  /** 「Add a sign-in method」有沒有展開（與原選單的「Browser wallets」同一種互動）。 */
  const [adding, setAdding] = useState(false);
  /** SDK 還沒載完就按了登入：記下來，好了就打開。 */
  const [wantLogin, setWantLogin] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const hasPanel = signedIn || busy || failed || unavailable;

  function start(): void {
    if (hasPanel) setOpen((current) => !current);
    else if (phase === 'signed-out') openSignIn();
    else setWantLogin(true);
  }

  // 按了登入但 SDK 一直沒好：等 12 秒就改成說明，不無限期顯示「Signing in…」。
  useEffect(() => {
    if (!wantLogin) return;
    const timer = window.setTimeout(() => {
      setWantLogin(false);
      setStalled(true);
      setOpen(true);
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [wantLogin]);
  useEffect(() => {
    if (wantLogin && phase === 'unavailable') {
      setWantLogin(false);
      setOpen(true);
    }
  }, [wantLogin, phase]);

  useEffect(() => {
    if (!wantLogin || phase === 'loading' || phase === 'unavailable' || actions === null) return;
    setWantLogin(false);
    if (phase === 'signed-out') openSignIn();
    else setOpen(true);
  }, [wantLogin, phase, actions]);

  // 失敗時自動把原因攤開：使用者剛在 Privy 視窗完成登入，回來卻沒有登入，不該要他自己去找原因。
  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);

  useEffect(() => {
    if (!open || inline) return;
    const onClick = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, inline]);

  // `/#wallet` 深連結與頁面上的「Sign in」連結：只由標頭那一個處理，頁面內的不重複反應。
  useEffect(() => {
    if (inline) return;
    const onOpen = (): void => {
      const current = usePrivyAuth.getState();
      if (current.phase === 'signed-out') openSignIn();
      else if (current.phase === 'loading') setWantLogin(true);
      else setOpen(true);
    };
    if (window.location.hash === '#wallet') onOpen();
    window.addEventListener(openEvent, onOpen);
    return () => window.removeEventListener(openEvent, onOpen);
  }, [inline, openEvent]);

  const notice = signedIn ? readOnlyNotice({ owner, ownerEmbedded, signer }) : null;
  const canConnectOwner = notice !== null && !ownerEmbedded;
  const failure = failed ? explainPrivyLoginFailure(error) : null;

  // 頁面內（inline）的按鈕出現在「需要登入或需要錢包才能繼續」的位置：
  // 已登入但主人錢包沒連著時，它就是「連上主人錢包」。
  const inlineConnect = inline && signedIn && canConnectOwner;
  const label = signedIn
    ? inlineConnect ? `Connect wallet ${shortAddress(owner)}` : shortAddress(owner)
    : busy || wantLogin ? 'Signing in…' : 'Sign in';

  return (
    <div className={inline ? 'wallet-menu wallet-menu--inline' : 'wallet-menu'} ref={rootRef}>
      <button
        type="button"
        className={inline ? 'btn primary block' : `btn sm header-wallet${iconOnly ? ' app-wallet-toolbar' : ''}`}
        aria-haspopup={hasPanel ? 'menu' : 'dialog'}
        aria-expanded={hasPanel ? open : undefined}
        aria-label={iconOnly ? label : undefined}
        aria-busy={busy || wantLogin || undefined}
        data-wallet-state={signedIn ? 'verified' : busy ? 'unverified' : 'disconnected'}
        onClick={() => (inlineConnect ? actions?.connectOwnerWallet() : start())}
      >
        {(showIcon || iconOnly) && <AppIcon name="wallet" size={iconOnly ? 23 : 19} />}
        {!iconOnly && label}
      </button>

      {inline && notice !== null ? <p className="wallet-menu__hint" role="status">{notice}</p> : null}

      {open && hasPanel ? (
        <div className="wallet-menu__panel" role="menu">
          {unavailable ? (
            <>
              <Note tone="bad">
                <strong>Sign-in is not available</strong>
                <div style={{ marginTop: 6 }}>
                  The sign-in service could not be loaded. Check your connection, then reload the page. You can keep browsing funds in the meantime.
                </div>
                <TechnicalDetails text={error instanceof Error ? error.message : error === null ? 'Privy SDK did not become ready' : String(error)} />
              </Note>
              <button type="button" className="btn sm" onClick={() => window.location.reload()}>
                Reload
              </button>
            </>
          ) : busy ? (
            <>
              <p className="wallet-menu__title">Signing you in…</p>
              <p className="wallet-menu__hint" role="status">
                {phase === 'creating-wallet' ? 'Setting up your CRE8 wallet.' : 'Confirming your sign-in with CRE8.'}
              </p>
              <button type="button" className="wallet-menu__link" onClick={() => void actions?.logout()}>
                Cancel
              </button>
            </>
          ) : failure !== null ? (
            <>
              <Note tone="bad">
                <strong>Sign-in not completed</strong>
                <div style={{ marginTop: 6 }}>{failure.message}</div>
                <TechnicalDetails text={failure.technical} />
              </Note>
              {failure.action === 'retry' && (
                <button type="button" className="btn sm" onClick={() => actions?.retry()}>
                  Try again
                </button>
              )}
              {failure.action === 'sign-in-again' && (
                <button type="button" className="btn sm" onClick={() => void actions?.logout().then(openSignIn)}>
                  Sign in again
                </button>
              )}
              <button type="button" className="wallet-menu__link" onClick={() => void actions?.logout()}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <p className="wallet-menu__addr mono" title={owner ?? undefined}>{shortAddress(owner ?? '')}</p>
              <p className="wallet-menu__status">Signed in</p>
              {methods.length > 0 && (
                <ul className="wallet-menu__methods" aria-label="Sign-in methods">
                  {methods.map((method) => (
                    <li key={`${method.kind}:${method.detail}`}>
                      <span>{signInMethodName(method.kind)}</span>
                      {method.detail !== '' && <span className="wallet-menu__method-detail">{method.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {notice !== null && <p className="wallet-warning" role="status">{notice}</p>}
              {canConnectOwner && (
                <button type="button" className="wallet-menu__item" role="menuitem" onClick={() => actions?.connectOwnerWallet()}>
                  Connect wallet {shortAddress(owner ?? '')}
                </button>
              )}
              <Link className="wallet-menu__item" to="/portfolios" onClick={() => setOpen(false)}>
                Profile
              </Link>
              {linkableMethods(methods).length > 0 && (
                <button type="button" className="wallet-menu__item" role="menuitem" aria-expanded={adding} onClick={() => setAdding((current) => !current)}>
                  Add a sign-in method
                </button>
              )}
              {adding && linkableMethods(methods).map((kind) => (
                <button key={kind} type="button" className="wallet-menu__item" role="menuitem" onClick={() => actions?.link(kind)}>
                  {signInMethodName(kind)}
                </button>
              ))}
              {ownerEmbedded && (
                <>
                  <button type="button" className="wallet-menu__item" role="menuitem" onClick={() => void actions?.exportWallet()}>
                    Export wallet key
                  </button>
                  <p className="wallet-menu__hint">
                    Your key opens in a secure window from Privy. CRE8 never sees it. Anyone with the key controls your funds.
                  </p>
                </>
              )}
              <button
                type="button"
                className="wallet-menu__link"
                onClick={() => {
                  setOpen(false);
                  void actions?.logout();
                }}
              >
                Sign out
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 全站橫幅：已登入，但主人錢包沒有連著（只能看）。
 *
 * 最常見的情況是用錢包註冊、後來改用 Google／Apple／email 登入：帳戶看得到，但買、賣、提領都要
 * 主人錢包簽名。那些按鈕會因為沒有錢包而停用，這一條說明原因並給連上原錢包的入口。
 */
export function OwnerWalletNotice(): ReactNode {
  const { ownerEmbedded, signer, actions } = usePrivyAuth();
  const token = useConnectedSessionToken();
  const owner = useSession((state) => state.address);
  const notice = token === null ? null : readOnlyNotice({ owner, ownerEmbedded, signer });
  if (notice === null) return null;
  return (
    <div className="platform-banner owner-wallet-banner" role="status">
      <strong>View only.</strong> {notice}
      {/* 提示裡的動作沿用既有寫法：底線文字的 `.link-button`（跟基金頁的「Open My position」一樣），不放實心按鈕。 */}
      {!ownerEmbedded && (
        <>
          {' '}
          <button type="button" className="link-button" onClick={() => actions?.connectOwnerWallet()}>
            Connect wallet
          </button>
        </>
      )}
    </div>
  );
}
