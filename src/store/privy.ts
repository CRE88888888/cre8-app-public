import { create } from 'zustand';
import type { Profile, SignInMethod, SignInMethodKind } from '../lib/privy-owner';
import type { SignInReason } from '../lib/sign-in-reason';

/**
 * Privy 登入的畫面狀態（cre8-app#57）。
 *
 * 為什麼要有這個 store：Privy SDK 很大，只在有設定 App ID 時才動態載入，而且它的 hooks 只能在
 * `PrivyProvider` 底下用。標頭的選單、頁面裡的登入按鈕都在那棵樹外面，所以由
 * `features/auth/PrivyRoot.tsx`（唯一 import SDK 的檔案）把狀態與動作同步到這裡，其他元件只讀這個 store。
 *
 * CRE8 session 本身仍在 `store/session.ts`；這裡只放「Privy 那一側」的東西。
 */
export type PrivyPhase =
  /** SDK 還在載入或初始化。 */
  | 'loading'
  | 'signed-out'
  /** 已通過 Privy 登入，等嵌入式錢包建好。 */
  | 'creating-wallet'
  /** 拿 identity token 向後端換 CRE8 session。 */
  | 'exchanging'
  | 'signed-in'
  /** 換 session 失敗，等使用者處理（`error`）。 */
  | 'error'
  /** SDK 載不下來或初始化失敗（斷線、App ID 不對）。登入不能用，其餘頁面照常。 */
  | 'unavailable';

/** email 驗證碼登入走到哪一步（Privy `useLoginWithEmail` 的 `state.status`）。 */
export type EmailStep = 'initial' | 'sending-code' | 'awaiting-code-input' | 'submitting-code' | 'done' | 'error';

export type PrivyActions = {
  /** 用 Google／X 登入：轉到對方的登入頁，回來後由 Privy 完成（headless，不開 Privy 的視窗）。X 在 Privy 叫 `twitter`。 */
  loginWithOAuth: (provider: 'google' | 'twitter') => Promise<void>;
  /** 寄 email 驗證碼。 */
  sendEmailCode: (email: string) => Promise<void>;
  /** 用收到的驗證碼登入。 */
  submitEmailCode: (code: string) => Promise<void>;
  /** 用錢包登入：只開 Privy 的選錢包視窗。 */
  loginWithWallet: () => void;
  /** 登出 Privy 並清掉 CRE8 session。 */
  logout: () => Promise<void>;
  /** 換 session 失敗後再試一次。 */
  retry: () => void;
  /** 加綁一種登入方式。只在已經有 CRE8 session 時可以呼叫（見 `PrivyRoot`）。 */
  link: (kind: SignInMethodKind) => void;
  /** 連上主人的外部錢包（只連線、不綁定），之後才能簽名。 */
  connectOwnerWallet: () => void;
  /** 打開 Privy 的匯出私鑰視窗（嵌入式錢包）。私鑰在 Privy 的 iframe 裡，app 讀不到。 */
  exportWallet: () => Promise<void>;
};

export type PrivyAuthState = {
  phase: PrivyPhase;
  error: unknown;
  /** 帳號上已綁的登入方式。 */
  methods: SignInMethod[];
  /** 用戶頁上方的名字與頭像（取自已綁的 X／Google／email）。 */
  profile: Profile;
  /** 主人是不是 Privy 的嵌入式錢包。 */
  ownerEmbedded: boolean;
  /** 主人錢包現在能不能簽名：`checking` = 還在等 Privy 回報錢包。 */
  signer: 'checking' | 'ready' | 'missing';
  /** email 登入的進度與錯誤（給登入頁用）。 */
  emailStep: EmailStep;
  emailError: unknown;
  /** 加綁 X／Google 沒成功時給使用者看的話（`explainLinkFailure`）。使用者自己關掉視窗不算。 */
  linkError: string | null;
  /** Google／X 登入的錯誤（轉址前就失敗時）。 */
  oauthError: unknown;
  /** 登入頁開著沒有。在這裡而不是元件裡：標頭、頁面內的按鈕都要能打開同一頁。 */
  signInOpen: boolean;
  /**
   * 為了什麼而登入（要買、要賣、要建立基金）。有值時登入頁是**整頁**並寫明原因；
   * 沒有（使用者自己按標頭的 Sign in）就是原本置中的卡片。
   */
  signInFor: SignInReason | null;
  actions: PrivyActions | null;
  /** Privy 的 identity token（waitlist 用它向後端證明是哪個 X 帳號）。只在記憶體，不存。 */
  identityToken: string | null;
};

export const PRIVY_INITIAL: PrivyAuthState = {
  phase: 'loading',
  error: null,
  methods: [],
  profile: { name: null, handle: null, avatarUrl: null },
  ownerEmbedded: false,
  signer: 'checking',
  emailStep: 'initial',
  emailError: null,
  oauthError: null,
  linkError: null,
  signInOpen: false,
  signInFor: null,
  actions: null,
  identityToken: null,
};

export function openSignIn(reason: SignInReason | null = null): void {
  usePrivyAuth.setState({ signInOpen: true, signInFor: reason });
}

export function closeSignIn(): void {
  usePrivyAuth.setState({ signInOpen: false, signInFor: null });
}

export const usePrivyAuth = create<PrivyAuthState>()(() => PRIVY_INITIAL);
