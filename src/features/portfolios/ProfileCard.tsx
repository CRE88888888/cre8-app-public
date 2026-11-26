import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Pencil, Settings } from 'lucide-react';
import { AppIcon } from '../../components/AppIcon';
import { shortAddress } from '../../lib/format';
import { PRIVY_ENABLED } from '../../lib/privy-config';
import { emailIdentity, linkableMethods, signInMethodName } from '../../lib/privy-owner';
import type { SignInMethodKind } from '../../lib/privy-owner';
import { DISPLAY_NAME_MAX, displayNameOf, initialOf } from '../../lib/profile-name';
import { usePrivyAuth } from '../../store/privy';
import { useCustomName, useProfileNames } from '../../store/profile-names';
import { useSession } from '../../store/session';

/**
 * 用戶頁上方：頭像、名字、齒輪。
 *
 * 名字可以自己取：點名字（旁邊有鉛筆）就在原地變成輸入框，Enter 或 Save 存、Esc 取消。
 * 沒有自己取的時候，用已綁的 X／Google／email 的名字（`lib/privy-owner.ts` 的 `profileOf`），再沒有就顯示錢包地址。
 * 後端沒有用戶資料，所以自己取的名字存在這台裝置（`store/profile-names.ts`），只有本人看得到。
 *
 * 這個元件不 import Privy SDK：狀態與動作來自 `usePrivyAuth`。
 */
export function ProfileHeader({ address, onSettings }: {
  address: string | null;
  /** 打開帳號設定（綁定、匯出私鑰、登出）。 */
  onSettings: () => void;
}): ReactNode {
  const { profile } = usePrivyAuth();
  const custom = useCustomName(address);
  const setName = useProfileNames((state) => state.setName);
  const linked = PRIVY_ENABLED ? profile.name : null;
  const name = displayNameOf({ custom, linked });
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();

  useEffect(() => {
    if (draft !== null) inputRef.current?.select();
    // 只在「開始編輯」那一刻選取全部文字，打字途中不要再選。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft === null]);

  function save(event: FormEvent): void {
    event.preventDefault();
    if (address === null || draft === null) return;
    setName(address, draft);
    setDraft(null);
  }

  return (
    <section className="profile-head" aria-label="Your profile">
      <Avatar name={name} src={PRIVY_ENABLED ? profile.avatarUrl : null} />
      {draft === null ? (
        <div className="profile-head__text">
          <h2>
            {address === null ? (name ?? 'Your account') : (
              <button type="button" className="profile-head__name" aria-label={`${name ?? shortAddress(address)}. Edit your name`} onClick={() => setDraft(custom ?? '')}>
                <span>{name ?? shortAddress(address)}</span>
                <Pencil size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </h2>
          <p>
            {PRIVY_ENABLED && profile.handle !== null && <span>@{profile.handle}</span>}
            {/* 沒有名字時標題本身就是地址，不要再寫一次。 */}
            {address !== null && name !== null && <span className="mono" title={address}>{shortAddress(address)}</span>}
          </p>
        </div>
      ) : (
        <form className="profile-head__edit" onSubmit={save} onKeyDown={(event) => { if (event.key === 'Escape') setDraft(null); }}>
          <label className="field">
            <span>Your name</span>
            <input
              ref={inputRef}
              type="text"
              autoComplete="nickname"
              // 上限以「字」計（見 cleanDisplayName）；這裡放寬給 emoji 等多碼位的字，存的時候才截。
              maxLength={DISPLAY_NAME_MAX * 4}
              placeholder={linked ?? 'Add a name'}
              aria-describedby={hintId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="profile-head__edit-actions">
            <button type="submit" className="btn sm">Save</button>
            <button type="button" className="btn ghost sm" onClick={() => setDraft(null)}>Cancel</button>
          </div>
          <small id={hintId}>
            Up to {DISPLAY_NAME_MAX} characters. Saved on this device; only you can see it.
            {linked !== null && ` Leave it empty to use “${linked}”.`}
          </small>
        </form>
      )}
      {draft === null && (
        // 桌機：文字按鈕（參考 fomo 桌機版名字右邊的「編輯資料」）；手機：只有齒輪。樣式是既有的 .btn.ghost.sm。
        <button type="button" className="btn ghost sm profile-head__settings" aria-label="Account settings" onClick={onSettings}>
          <Settings size={19} strokeWidth={1.8} aria-hidden="true" /> <span>Account</span>
        </button>
      )}
    </section>
  );
}

/**
 * 登出鍵，放在 Account 面板最下面。
 * Privy 模式：登出 Privy 並清掉 CRE8 session。原本的錢包登入：清掉 session（跟標頭選單的 Sign out 一樣）。
 */
export function SignOutButton({ onDone }: { onDone: () => void }): ReactNode {
  const actions = usePrivyAuth((state) => state.actions);
  const clearSession = useSession((state) => state.clear);
  return (
    <button
      type="button"
      className="btn ghost block profile-signout"
      onClick={() => {
        onDone();
        if (PRIVY_ENABLED) void actions?.logout();
        else clearSession();
      }}
    >
      Sign out
    </button>
  );
}

/**
 * 帳號面板的內容，固定三列：Email、X、Wallet。**不放在用戶頁上**，在齒輪打開的設定面板裡
 * （使用者回饋：還沒看到自己的錢就一堆東西要綁定很怪；參考 fomo 把綁定收進設定）。
 *
 * 使用者回饋（2026-11-14）後的兩個規則：
 * - Email 與 Google 是同一件事，只有一列。
 * - 錢包只有一個（註冊時決定的錢包主人），不提供再綁錢包。
 */
export function LinkedAccounts({ address }: { address: string | null }): ReactNode {
  const { methods, ownerEmbedded, actions, linkError } = usePrivyAuth();
  if (!PRIVY_ENABLED) return null;
  const linkable = new Set(linkableMethods(methods));
  const email = emailIdentity(methods);
  const x = methods.find((method) => method.kind === 'x') ?? null;
  return (
    <section className="profile-accounts" aria-label="Linked accounts">
      {/* 信箱：Google 與 email 驗證碼對使用者是同一件事，只有一列。沒有信箱的人（用錢包註冊）可以綁 Google。 */}
      <div className="profile-row" data-linked={email !== null || undefined}>
        <span className="profile-row__icon" aria-hidden="true"><KindMark kind={email?.kind ?? 'email'} /></span>
        <span className="profile-row__text">
          <b>Email</b>
          <small>{email === null ? 'Not linked' : email.detail || signInMethodName(email.kind)}</small>
        </span>
        {email !== null && <span className="badge badge--ok">Linked</span>}
        {linkable.has('google') && actions !== null && (
          <button type="button" className="btn ghost sm" onClick={() => actions.link('google')}>Link Google</button>
        )}
      </div>
      <div className="profile-row" data-linked={x !== null || undefined}>
        <span className="profile-row__icon" aria-hidden="true"><KindMark kind="x" /></span>
        <span className="profile-row__text">
          <b>X</b>
          <small>{x === null ? 'Not linked' : x.detail || 'Linked'}</small>
        </span>
        {x !== null && <span className="badge badge--ok">Linked</span>}
        {linkable.has('x') && actions !== null && (
          <button type="button" className="btn ghost sm" onClick={() => actions.link('x')}>Link</button>
        )}
      </div>
      {/* 錢包只有一個：註冊時決定的錢包主人。CRE8 幫你建的可以匯出私鑰；自己帶來的錢包私鑰本來就在你手上。 */}
      {address !== null && (
        <div className="profile-row" data-linked>
          <span className="profile-row__icon" aria-hidden="true"><AppIcon name="wallet" size={20} /></span>
          <span className="profile-row__text">
            <b>Wallet</b>
            <small className="mono" title={address}>{shortAddress(address)}</small>
          </span>
          {ownerEmbedded && (
            <button type="button" className="btn ghost sm" onClick={() => void actions?.exportWallet()}>
              Export key
            </button>
          )}
        </div>
      )}
      {/* 加綁失敗（最常見：這個 X／Google 已經單獨註冊過另一個 CRE8 帳號，Privy 不會合併兩個帳號）。 */}
      {linkError !== null && <p className="profile-accounts__error" role="alert">{linkError}</p>}
      <p className="profile-accounts__note">
        {ownerEmbedded
          ? 'CRE8 created this wallet for you. Your key opens in a secure window from Privy; CRE8 never sees it.'
          : 'This is the wallet you signed up with. It owns your funds here.'}
      </p>
      {/* 用外部錢包註冊的人：之後用 X／Google 登入看得到帳戶，但需要簽名的事（買、賣、提領）要用原本的錢包。 */}
      {!ownerEmbedded && (
        <p className="profile-accounts__note">
          Signing in with X or Google lets you view your account. Buying, selling and anything else that needs a signature still uses this wallet.
        </p>
      )}
    </section>
  );
}

function Avatar({ name, src }: { name: string | null; src: string | null }): ReactNode {
  if (src !== null) return <img className="profile-avatar" src={src} alt="" width={72} height={72} referrerPolicy="no-referrer" />;
  const initial = initialOf(name);
  return (
    <span className="profile-avatar profile-avatar--empty" aria-hidden="true">
      {initial ?? <AppIcon name="profile" size={30} />}
    </span>
  );
}

function KindMark({ kind }: { kind: SignInMethodKind }): ReactNode {
  if (kind === 'wallet') return <AppIcon name="wallet" size={20} />;
  if (kind === 'email') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
        <path d="m4 7 8 6 8-6" />
      </svg>
    );
  }
  if (kind === 'x') {
    // X 的標誌（字母 X 的官方圖形）。
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.82l4.71 6.23Zm-1.16 17.52h1.83L7.08 4.13H5.12Z" />
      </svg>
    );
  }
  if (kind === 'google') {
    return (
      <svg width="20" height="20" viewBox="0 0 48 48">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    );
  }
  return null;
}
