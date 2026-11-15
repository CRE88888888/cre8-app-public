import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { confirmSignIn, lastSignIn, notePendingSignIn } from '../lib/last-sign-in';
import type { SignInChoice } from '../lib/last-sign-in';
import { signInCopy } from '../lib/sign-in-reason';
import { showCodeStep, trapFocus } from '../lib/sign-in-steps';
import { closeSignIn, usePrivyAuth } from '../store/privy';
import { AppIcon } from './AppIcon';

/**
 * 我們自己的登入頁（Privy 模式，`VITE_PRIVY_APP_ID` 有設定時）。
 *
 * 版面參考使用者給的登入畫面：上面是品牌與一句話，下面一排大按鈕，主要的一顆實心、其餘淺色。
 * 樣式沿用 app 既有的：實心＝`.btn`、淺色＝`.btn.ghost`，只把高度與字級放大。
 *
 * Google／X 會轉到對方的登入頁，回來後由 `PrivyRoot` 完成；email 在這一頁收驗證碼；
 * 錢包打開 Privy 的選錢包視窗。Privy 那一側登入完成後這一頁自己關掉，後面的進度在標頭的選單裡。
 *
 * 這個元件不 import Privy SDK：動作來自 `usePrivyAuth`。
 *
 * 樣子（使用者選的 A：iOS 底部面板）：手機從下面滑上來、後面的頁面模糊；桌機是置中的大圓角卡片。
 * 按鈕是膠囊：Google 白底細框、X 黑底（兩家的品牌規範）、email 與錢包淺灰。上次用的那一顆標「Last used」。
 * 點旁邊、按 Escape、按最下面的「Not now」都會關掉。標題依原因而定：要買、要賣、要建立基金時寫明為了什麼
 * （逛的時候不用登入，到這一步才出現）；自己按標頭的 Sign in 是「Sign in to CRE8」。
 */
function storageOrNull(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

export function SignInScreen(): ReactNode {
  const { signInOpen, signInFor, phase, actions, emailStep, emailError, oauthError } = usePrivyAuth();
  const [step, setStep] = useState<'choose' | 'email' | 'code'>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [leaving, setLeaving] = useState<'google' | 'twitter' | null>(null);
  /** 使用者看到錯誤後又改了輸入：先把錯誤收起來，下一次送出再看結果。 */
  const [edited, setEdited] = useState(false);
  /** 上次用哪一種方式登入（這台裝置）：那一顆標「Last used」並當成主要按鈕。沒有紀錄時主要按鈕是 Google。 */
  const [last, setLast] = useState<SignInChoice | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** 這一次按了 Send code（或 Send a new code）、還在等結果。只有它成功才換到輸入驗證碼。 */
  const codeRequested = useRef(false);
  /** 打開前焦點在哪裡：關掉後還給它。 */
  const returnFocus = useRef<HTMLElement | null>(null);

  // 每次打開都從頭開始。
  useEffect(() => {
    if (!signInOpen) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    codeRequested.current = false;
    setStep('choose');
    setCode('');
    setLeaving(null);
    setLast(lastSignIn(storageOrNull('localStorage')));
    window.setTimeout(() => firstRef.current?.focus(), 0);
  }, [signInOpen]);

  // 寄出驗證碼後換到輸入驗證碼：只看這一次寄碼的結果，不看 SDK 一直停著的狀態（換信箱時不會被拉回來）。
  useEffect(() => {
    if (showCodeStep({ step, emailStep, requested: codeRequested.current })) {
      codeRequested.current = false;
      setStep('code');
    }
    if (emailStep === 'error') codeRequested.current = false;
  }, [emailStep, step]);

  // 關掉時把焦點還給打開前的那個元素。
  useEffect(() => {
    if (signInOpen) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }, [signInOpen]);

  useEffect(() => {
    if (step !== 'choose') window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [step]);

  // 真的登入成功才把剛才按的那一種記成「上次用的」。
  useEffect(() => {
    if (phase === 'signed-in') confirmSignIn(storageOrNull('sessionStorage'), storageOrNull('localStorage'));
  }, [phase]);

  // OAuth 在轉址前就失敗：按鈕不要一直轉。
  useEffect(() => {
    if (oauthError !== null) setLeaving(null);
  }, [oauthError]);

  useEffect(() => {
    if (!signInOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeSignIn();
      if (event.key !== 'Tab' || cardRef.current === null) return;
      // 焦點留在對話框裡：Tab 到最後一個回第一個，Shift+Tab 反過來；從外面 Tab 進來也拉回對話框。
      const focusables = [...cardRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const next = trapFocus(focusables, active !== null && cardRef.current.contains(active) ? active : null, event.shiftKey);
      if (next !== null) {
        event.preventDefault();
        next.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [signInOpen]);

  if (!signInOpen) return null;

  const copy = signInCopy(signInFor);

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

  function oauth(provider: 'google' | 'twitter'): void {
    if (!ready) return;
    setLeaving(provider);
    notePendingSignIn(storageOrNull('sessionStorage'), provider === 'twitter' ? 'x' : provider);
    void actions?.loginWithOAuth(provider);
  }

  function sendEmail(event: FormEvent): void {
    event.preventDefault();
    if (!ready || !emailValid || sending) return;
    setEdited(false);
    codeRequested.current = true;
    void actions?.sendEmailCode(email.trim());
  }

  function submitCode(event: FormEvent): void {
    event.preventDefault();
    if (!ready || !codeValid || checking) return;
    setEdited(false);
    notePendingSignIn(storageOrNull('sessionStorage'), 'email');
    void actions?.submitEmailCode(code.trim());
  }

  return (
    <div className="signin-screen" data-reason={signInFor?.purpose} role="dialog" aria-modal="true" aria-labelledby="signin-title">
      <div className="signin-screen__backdrop" aria-hidden="true" onClick={closeSignIn} />
      <div className="signin-screen__card" ref={cardRef}>
        <header className="signin-screen__head">
          <img src="/logos/cre8-icon.svg" alt="" width={64} height={64} />
          <h2 id="signin-title">{copy.title}</h2>
          <p>{copy.body}</p>
        </header>

        {step === 'choose' ? (
          <div className="signin-screen__options">
            <button ref={firstRef} type="button" className="btn ghost block" data-method="google" disabled={!ready || leaving !== null} onClick={() => oauth('google')}>
              <GoogleMark /> {leaving === 'google' ? 'Opening Google…' : 'Continue with Google'}
              {last === 'google' && <LastUsed />}
            </button>
            <button type="button" className="btn block" data-method="x" disabled={!ready || leaving !== null} onClick={() => oauth('twitter')}>
              <XMark /> {leaving === 'twitter' ? 'Opening X…' : 'Continue with X'}
              {last === 'x' && <LastUsed />}
            </button>
            <button type="button" className="btn ghost block" data-method="email" disabled={!ready || leaving !== null} onClick={() => setStep('email')}>
              <MailMark /> Continue with email
              {last === 'email' && <LastUsed />}
            </button>
            <button
              type="button"
              className="btn ghost block" data-method="wallet"
              disabled={!ready || leaving !== null}
              onClick={() => {
                notePendingSignIn(storageOrNull('sessionStorage'), 'wallet');
                closeSignIn();
                actions?.loginWithWallet();
              }}
            >
              <AppIcon name="wallet" size={20} /> Connect a wallet
              {last === 'wallet' && <LastUsed />}
            </button>
            {oauthError !== null && oauthError !== undefined && (
              <p className="signin-screen__error" role="alert">That sign-in could not be started. Please try again.</p>
            )}
            {!ready && <p className="signin-screen__hint" role="status">Getting sign-in ready…</p>}
            <button type="button" className="signin-screen__text" onClick={closeSignIn}>
              Not now
            </button>
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
                aria-invalid={emailProblem !== null || undefined}
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
            <button type="button" className="signin-screen__text" onClick={() => setStep('choose')}>
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
                aria-invalid={emailProblem !== null || undefined}
                placeholder="000000"
                value={code}
                onChange={(event) => {
                  // 不用 maxLength：貼上「123 456」「123-456」時它會先截成 6 個字元再進來，少一位數。
                  // 先去掉非數字，再取前 6 位。
                  setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
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
                className="signin-screen__text"
                disabled={sending}
                onClick={() => {
                  setEdited(false);
                  setCode('');
                  void actions?.sendEmailCode(email.trim());
                }}
              >
                {sending ? 'Sending…' : 'Send a new code'}
              </button>
              <button type="button" className="signin-screen__text" onClick={() => { codeRequested.current = false; setCode(''); setStep('email'); }}>
                Use another email
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function LastUsed(): ReactNode {
  return <span className="signin-last">Last used</span>;
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

/** X 的標誌（字母 X 的官方圖形）。 */
function XMark(): ReactNode {
  return (
    <svg className="signin-mark" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.82l4.71 6.23Zm-1.16 17.52h1.83L7.08 4.13H5.12Z" />
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
