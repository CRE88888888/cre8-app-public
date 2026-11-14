import { create } from 'zustand';
import type { SignInMethod, SignInMethodKind } from '../lib/privy-owner';

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

export type PrivyActions = {
  /** 打開 Privy 的登入視窗。 */
  login: () => void;
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
  /** 主人是不是 Privy 的嵌入式錢包。 */
  ownerEmbedded: boolean;
  /** 主人錢包現在能不能簽名：`checking` = 還在等 Privy 回報錢包。 */
  signer: 'checking' | 'ready' | 'missing';
  actions: PrivyActions | null;
};

export const PRIVY_INITIAL: PrivyAuthState = {
  phase: 'loading',
  error: null,
  methods: [],
  ownerEmbedded: false,
  signer: 'checking',
  actions: null,
};

export const usePrivyAuth = create<PrivyAuthState>()(() => PRIVY_INITIAL);
