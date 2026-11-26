/**
 * 為了什麼而登入。純邏輯（不 import React、不 import Privy）。
 *
 * 使用者的決定：逛基金、設計基金都不用登入，**到要買、要賣、要建立的那一刻才出現登入頁**——
 * 一打開就擋一頁登入會流失一部分人。那一刻的登入頁是整頁的，並寫明登入是為了什麼、登入完會回到哪裡。
 */
export type SignInReason = {
  purpose: 'buy' | 'sell' | 'create';
  /** 基金的名字（買、賣時）。 */
  subject?: string;
};

export type SignInCopy = { title: string; body: string; /** 頁面內那顆按鈕上的字。 */ button: string };

const GENERIC: SignInCopy = {
  body: 'Follow the funds you believe in, from one account.',
  button: 'Sign in',
  title: 'Sign in to CRE8',
};

export function signInCopy(reason: SignInReason | null | undefined): SignInCopy {
  if (reason === null || reason === undefined) return GENERIC;
  const subject = reason.subject?.trim() ?? '';
  const back = subject === '' ? 'You’ll come right back here.' : `You’ll come right back to ${subject}.`;
  if (reason.purpose === 'buy') return { body: back, button: 'Sign in to buy', title: 'Sign in to buy' };
  if (reason.purpose === 'sell') return { body: back, button: 'Sign in to sell', title: 'Sign in to sell' };
  return {
    body: 'Your design is saved. You’ll come right back to it.',
    button: 'Sign in to create',
    title: 'Sign in to create your fund',
  };
}

/** 事件帶進來的資料不可信：形狀不對就當成沒有原因。 */
export function signInReasonOf(value: unknown): SignInReason | null {
  if (typeof value !== 'object' || value === null) return null;
  const { purpose, subject } = value as { purpose?: unknown; subject?: unknown };
  if (purpose !== 'buy' && purpose !== 'sell' && purpose !== 'create') return null;
  return typeof subject === 'string' ? { purpose, subject } : { purpose };
}
