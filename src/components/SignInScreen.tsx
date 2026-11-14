import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { closeSignIn, usePrivyAuth } from '../store/privy';
import { AppIcon } from './AppIcon';

/**
 * 我們自己的登入頁（Privy 模式，`VITE_PRIVY_APP_ID` 有設定時）。
 *
 * 版面參考使用者給的登入畫面：上面是品牌與一句話，下面一排大按鈕，主要的一顆實心、其餘淺色。
 * 樣式沿用 app 既有的：實心＝`.btn`、淺色＝`.btn.ghost`，只把高度與字級放大。
 *
 * Google／Apple 會轉到對方的登入頁，回來後由 `PrivyRoot` 完成；email 在這一頁收驗證碼；
 * 錢包打開 Privy 的選錢包視窗。Privy 那一側登入完成後這一頁自己關掉，後面的進度在標頭的選單裡。
 *
 * 這個元件不 import Privy SDK：動作來自 `usePrivyAuth`。
 */
export function SignInScreen(): ReactNode {
  const { signInOpen, phase, actions, emailStep, emailError, oauthError } = usePrivyAuth();
  const [step, setStep] = useState<'choose' | 'email' | 'code'>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [leaving, setLeaving] = useState<'google' | 'apple' | null>(null);
  /** 使用者看到錯誤後又改了輸入：先把錯誤收起來，下一次送出再看結果。 */
  const [edited, setEdited] = useState(false);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 每次打開都從頭開始。
  useEffect(() => {
    if (!signInOpen) return;
    setStep('choose');
    setCode('');
    setLeaving(null);
    window.setTimeout(() => firstRef.current?.focus(), 0);
  }, [signInOpen]);

  // 寄出驗證碼後換到輸入驗證碼。
  useEffect(() => {
    if (emailStep === 'awaiting-code-input' && step === 'email') setStep('code');
  }, [emailStep, step]);

  useEffect(() => {
    if (step !== 'choose') window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [step]);

  // OAuth 在轉址前就失敗：按鈕不要一直轉。
  useEffect(() => {
    if (oauthError !== null) setLeaving(null);
  }, [oauthError]);

  useEffect(() => {
    if (!signInOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeSignIn();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [signInOpen]);

  if (!signInOpen) return null;

  const ready = actions !== null && phase === 'signed-out';
  const sending = emailStep === 'sending-code';
  const checking = emailStep === 'submitting-code';
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const codeValid = /^\d{6}$/.test(code.trim());
  const emailProblem = emailError === null || emailError === undefined || edited
    ? null
    : step === 'code'
      ? 'That code did not work. Check it, or send a new one.'
      : 'We could not send a code to that address. Check it and try again.';

  function oauth(provider: 'google' | 'apple'): void {
    if (!ready) return;
    setLeaving(provider);
    void actions?.loginWithOAuth(provider);
  }

  function sendEmail(event: FormEvent): void {
    event.preventDefault();
    if (!ready || !emailValid || sending) return;
    setEdited(false);
    void actions?.sendEmailCode(email.trim());
  }

  function submitCode(event: FormEvent): void {
    event.preventDefault();
    if (!ready || !codeValid || checking) return;
    setEdited(false);
    void actions?.submitEmailCode(code.trim());
  }

  return (
    <div className="signin-screen" role="dialog" aria-modal="true" aria-labelledby="signin-title">
      <div className="signin-screen__backdrop" aria-hidden="true" onClick={closeSignIn} />
      <div className="signin-screen__card">
        <button type="button" className="signin-screen__close" aria-label="Close" onClick={closeSignIn}>
          <AppIcon name="close" size={20} />
        </button>

        <header className="signin-screen__head">
          <img src="/logos/cre8-icon.svg" alt="" width={64} height={64} />
          <h2 id="signin-title">Sign in to CRE8</h2>
          <p>Follow the funds you believe in, from one account.</p>
        </header>

        {step === 'choose' ? (
          <div className="signin-screen__options">
            <button ref={firstRef} type="button" className="btn block" disabled={!ready || leaving !== null} onClick={() => oauth('google')}>
              <GoogleMark /> {leaving === 'google' ? 'Opening Google…' : 'Continue with Google'}
            </button>
            <button type="button" className="btn ghost block" disabled={!ready || leaving !== null} onClick={() => oauth('apple')}>
              <AppleMark /> {leaving === 'apple' ? 'Opening Apple…' : 'Continue with Apple'}
            </button>
            <button type="button" className="btn ghost block" disabled={!ready || leaving !== null} onClick={() => setStep('email')}>
              <MailMark /> Continue with email
            </button>
            <button
              type="button"
              className="btn ghost block"
              disabled={!ready || leaving !== null}
              onClick={() => {
                closeSignIn();
                actions?.loginWithWallet();
              }}
            >
              <AppIcon name="wallet" size={20} /> Connect a wallet
            </button>
            {oauthError !== null && oauthError !== undefined && (
              <p className="signin-screen__error" role="alert">That sign-in could not be started. Please try again.</p>
            )}
            {!ready && <p className="signin-screen__hint" role="status">Getting sign-in ready…</p>}
          </div>
        ) : step === 'email' ? (
          <form className="signin-screen__options" onSubmit={sendEmail}>
            <label className="field">
              <span>Email</span>
              <input
                ref={inputRef}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEdited(true);
                }}
              />
            </label>
            <button type="submit" className="btn block" disabled={!ready || !emailValid || sending}>
              {sending ? 'Sending code…' : 'Send code'}
            </button>
            {emailProblem && <p className="signin-screen__error" role="alert">{emailProblem}</p>}
            <button type="button" className="wallet-menu__link" onClick={() => setStep('choose')}>
              Other ways to sign in
            </button>
          </form>
        ) : (
          <form className="signin-screen__options" onSubmit={submitCode}>
            <p className="signin-screen__hint">
              We sent a 6-digit code to <b>{email.trim()}</b>.
            </p>
            <label className="field">
              <span>Code</span>
              <input
                ref={inputRef}
                className="signin-screen__code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, ''));
                  setEdited(true);
                }}
              />
            </label>
            <button type="submit" className="btn block" disabled={!ready || !codeValid || checking}>
              {checking ? 'Signing in…' : 'Sign in'}
            </button>
            {emailProblem && <p className="signin-screen__error" role="alert">{emailProblem}</p>}
            <div className="signin-screen__links">
              <button
                type="button"
                className="wallet-menu__link"
                disabled={sending}
                onClick={() => {
                  setEdited(false);
                  setCode('');
                  void actions?.sendEmailCode(email.trim());
                }}
              >
                {sending ? 'Sending…' : 'Send a new code'}
              </button>
              <button type="button" className="wallet-menu__link" onClick={() => setStep('email')}>
                Use another email
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** Google 的「G」（Google 登入按鈕規範的四色標誌）。 */
function GoogleMark(): ReactNode {
  return (
    <svg className="signin-mark" width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** Apple 標誌。圖形來自 Font Awesome Free 6（CC BY 4.0，https://fontawesome.com/license/free）。 */
function AppleMark(): ReactNode {
  return (
    <svg className="signin-mark" width="18" height="20" viewBox="0 0 384 512" aria-hidden="true">
      <path
        fill="currentColor"
        d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"
      />
    </svg>
  );
}

function MailMark(): ReactNode {
  return (
    <svg className="signin-mark" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}
