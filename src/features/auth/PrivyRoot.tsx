/**
 * Privy 登入（cre8-app#57）。**唯一 import Privy SDK 的檔案**，由 `App.tsx` 在有設定
 * `VITE_PRIVY_APP_ID` 時動態載入；沒設定時這個檔案與整個 SDK 都不會被下載。
 *
 * 它不包住 app：`PrivyProvider` 底下只有一個不畫任何東西的 `Bridge`，負責三件事 ——
 *   1. Privy 登入完成後，拿 identity token 向後端換 CRE8 session（`POST /auth/privy`）。
 *   2. 把「主人錢包」的 provider 放進 `useWallet` store，讓既有的簽名流程（kernel.ts）照常運作。
 *   3. 把狀態與動作同步到 `usePrivyAuth`，給標頭選單與頁面上的登入按鈕用。
 * Privy 自己的視窗（登入、連錢包、匯出私鑰）是 portal，不需要在它底下。
 */
import {
  PrivyProvider,
  useCreateWallet,
  useIdentityToken,
  useLoginWithEmail,
  useLoginWithOAuth,
  usePrivy,
  useUser,
  useLinkAccount,
  useWallets,
} from '@privy-io/react-auth';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, postPrivyLogin } from '../../lib/api';
import { CHAIN, CHAIN_ID } from '../../lib/kernel';
import { PRIVY_APP_ID, PRIVY_EMBEDDED_RDNS, PRIVY_LOGIN_METHODS, privyChain } from '../../lib/privy-config';
import {
  PrivySetupError,
  evmWallets,
  identityTokenWallets,
  profileOf,
  readRememberedOwner,
  rememberOwner,
  resolveOwner,
  sameAddress,
  signInMethods,
  explainLinkFailure,
  linkKindOf,
} from '../../lib/privy-owner';
import type { LinkedAccountLike, SignInMethodKind } from '../../lib/privy-owner';
import type { Eip1193Provider } from '../../lib/wallet';
import { PRIVY_INITIAL, usePrivyAuth } from '../../store/privy';
import type { PrivyActions, PrivyPhase } from '../../store/privy';
import { sessionIsLive, useSession } from '../../store/session';
import { useWallet } from '../../store/wallet';
import { createExchangeGuard } from '../../lib/exchange-guard';

/** 等嵌入式錢包建好、等 identity token 帶到它，最多等這麼久；超過就顯示錯誤與「再試一次」。 */
const SETUP_TIMEOUT_MS = 25_000;
/** Privy 回報「錢包已就緒」後，主人錢包仍沒出現多久才算「沒有」。避免剛載入時閃一下提示。 */
const SIGNER_GRACE_MS = 3_000;
/** 後端回 `PRIVY_NO_WALLET`（token 還沒帶到剛建好的錢包）時，自動重試幾次。 */
const AUTO_RETRIES = 2;
/** `POST /auth/privy` 最多等這麼久；到時 abort，顯示「再試一次」（cre8-app#93）。 */
const EXCHANGE_TIMEOUT_MS = 20_000;

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function Bridge(): null {
  const { ready, authenticated, user, error: initError, login, logout, connectWallet, exportWallet } = usePrivy();
  // 加綁用 useLinkAccount：才拿得到失敗原因（例如這個 X 已經單獨註冊過另一個帳號，Privy 會拒絕）。
  const { linkEmail, linkGoogle, linkTwitter, linkWallet } = useLinkAccount({
    onSuccess: () => usePrivyAuth.setState({ linkError: null }),
    onError: (code, details) => {
      const kind = linkKindOf(details?.linkMethod);
      usePrivyAuth.setState({ linkError: kind === null ? null : explainLinkFailure(code, kind) });
    },
  });
  const { wallets, ready: walletsReady } = useWallets();
  const { identityToken } = useIdentityToken();
  const { refreshUser } = useUser();
  const { createWallet } = useCreateWallet();
  // 登入頁是我們自己畫的（components/SignInScreen.tsx），用 Privy 的 headless 登入。
  // OAuth 的 hook 掛在這裡（一直存在），從 Google／X 轉回來的任何一頁都能完成登入。
  const { sendCode, loginWithCode, state: emailState } = useLoginWithEmail();
  const { initOAuth } = useLoginWithOAuth();
  const [oauthError, setOauthError] = useState<unknown>(null);
  const session = useSession();

  const [failure, setFailure] = useState<unknown>(null);
  /** 只用來讓「換 session」的 effect 再跑一次。 */
  const [attempt, setAttempt] = useState(0);
  const [signer, setSigner] = useState<'checking' | 'ready' | 'missing'>('checking');
  /** 換 session 的請求：有 timeout、登出或重試時撤銷，舊請求的結果不會寫進新的登入狀態（`lib/exchange-guard.ts`）。 */
  const [exchange] = useState(() => createExchangeGuard(EXCHANGE_TIMEOUT_MS));
  const autoRetries = useRef(0);
  const refreshedFor = useRef<string | null>(null);

  const accounts = (user?.linkedAccounts ?? null) as readonly LinkedAccountLike[] | null;
  const accountWallets = useMemo(() => evmWallets(accounts), [accounts]);
  const userId = authenticated ? (user?.id ?? null) : null;
  const privySession = session.via === 'privy' && sessionIsLive(session);
  /** 另一條路（SIWE）換來的 session 還有效時不要蓋掉它。Privy 模式下正常不會發生。 */
  const otherSession = session.via !== 'privy' && sessionIsLive(session);
  const owner = privySession ? session.address : null;

  // 非同步流程裡要讀「現在」的值，不是 effect 啟動當下的。
  const latest = useRef({ userId, accounts, accountWallets, privySession });
  latest.current = { userId, accounts, accountWallets, privySession };

  // ---- 登出（或 Privy 的登入過期）：CRE8 session 與錢包一起清掉 ------------------------------
  useEffect(() => {
    if (!ready || authenticated) return;
    exchange.cancel();
    const current = useSession.getState();
    if (current.via === 'privy') current.clear();
    const wallet = useWallet.getState();
    if (wallet.kind === 'injected') wallet.disconnect();
    setFailure(null);
    autoRetries.current = 0;
    refreshedFor.current = null;
  }, [ready, authenticated, exchange]);

  // ---- 換 CRE8 session ------------------------------------------------------------------------
  //
  // 順序是後端規則決定的（backend#65）：首次登入時帳號上要有**恰好一個** EVM 錢包。
  //   email／Google／X：Privy 登入完成 → Privy 建嵌入式錢包 → identity token 更新 → 才送。
  //   錢包登入：登入完成時那個錢包就在帳號上，直接送。
  // 在拿到 CRE8 session 之前，這個 app 不提供任何「加綁」的入口（見下面的 `link`）。
  useEffect(() => {
    if (!ready || !authenticated || userId === null || privySession || otherSession || failure !== null) return;
    if (exchange.busy()) return;
    if (accountWallets.length === 0) return; // 等嵌入式錢包（逾時由下面的 effect 處理）
    if (identityToken === null) return; // 等 Privy 給 identity token
    const signed = identityTokenWallets(identityToken);
    if (signed !== null && !accountWallets.some((wallet) => signed.includes(wallet.address.toLowerCase()))) {
      // token 是建錢包之前發的：請 Privy 重發一次，等它更新（`identityToken` 變了這個 effect 會再跑）。
      if (refreshedFor.current !== identityToken) {
        refreshedFor.current = identityToken;
        void refreshUser().catch(() => undefined);
      }
      return;
    }

    const ticket = exchange.start(userId);
    /** 這一次的結果還能不能用：沒被撤銷、沒有更新的一次、登入的還是同一個人。 */
    const current = (): boolean => ticket.isCurrent() && latest.current.userId === userId;
    void (async () => {
      try {
        const credentials = await postPrivyLogin(identityToken, ticket.signal);
        // 等回應的期間使用者可能已經登出或換人：那就丟掉這份 session。
        if (!current()) return;
        const storage = localStorageOrNull();
        const resolution = resolveOwner({
          responseAddress: credentials.address,
          accounts: latest.current.accounts,
          remembered: readRememberedOwner(storage, userId),
        });
        if (resolution === null) throw new PrivySetupError('NO_WALLET');
        rememberOwner(storage, userId, resolution);
        useSession.getState().setSession({
          token: credentials.token,
          expiresAt: credentials.expiresAt,
          address: resolution.owner,
          via: 'privy',
        });
        autoRetries.current = 0;
      } catch (cause) {
        // 舊的請求（已登出、換了人、或被重試撤銷）失敗：不寫進現在的登入狀態。
        if (!current()) return;
        ticket.done();
        if (cause instanceof ApiError && cause.code === 'PRIVY_NO_WALLET' && autoRetries.current < AUTO_RETRIES) {
          autoRetries.current += 1;
          await refreshUser().catch(() => undefined);
          await delay(1_500);
          setAttempt((count) => count + 1);
        } else {
          setFailure(cause);
        }
      } finally {
        ticket.done();
      }
    })();
  }, [ready, authenticated, userId, privySession, otherSession, failure, accountWallets, identityToken, attempt, refreshUser, exchange]);

  // ---- 嵌入式錢包沒有自動建：自己建 ------------------------------------------------------------
  // `createOnLogin` 在 Privy 的視窗登入時一定會建；用 headless 登入時文件沒有明說，所以登入後
  // 5 秒帳號上還沒有任何 EVM 錢包，就明確叫一次 createWallet()（每個使用者只叫一次）。
  // 只在「一個錢包都沒有」時做：用錢包登入的人帳號上本來就有錢包，不會多出第二個。
  const createdFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !authenticated || userId === null || privySession || failure !== null) return;
    if (accountWallets.length > 0 || createdFor.current === userId) return;
    const timer = window.setTimeout(() => {
      if (latest.current.accountWallets.length > 0 || createdFor.current === userId) return;
      createdFor.current = userId;
      void createWallet().catch(() => undefined);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [ready, authenticated, userId, privySession, failure, accountWallets.length, createWallet]);

  // ---- 等太久：講清楚卡在哪裡，給「再試一次」 --------------------------------------------------
  const waitingFor = !ready || !authenticated || privySession || otherSession || failure !== null
    ? null
    : accountWallets.length === 0 ? 'wallet' : identityToken === null ? 'token' : 'exchange';
  useEffect(() => {
    if (waitingFor === null) return;
    const timer = window.setTimeout(() => {
      // 交換請求有自己的 timeout（到時以錯誤結束），這裡只管「還在等錢包／token」。
      if (latest.current.privySession || exchange.busy()) return;
      setFailure(new PrivySetupError(waitingFor === 'token' ? 'NO_IDENTITY_TOKEN' : 'NO_WALLET'));
    }, SETUP_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [waitingFor, exchange]);

  // ---- 把主人錢包放進 `useWallet`（只放主人的；別的錢包一律不放） ------------------------------
  useEffect(() => {
    if (owner === null) {
      setSigner('checking');
      return;
    }
    const match = wallets.find((wallet) => wallet.type === 'ethereum' && sameAddress(wallet.address, owner));
    if (match === undefined) {
      const store = useWallet.getState();
      if (store.kind === 'injected') store.disconnect();
      if (!walletsReady) {
        setSigner('checking');
        return;
      }
      const timer = window.setTimeout(() => setSigner('missing'), SIGNER_GRACE_MS);
      return () => window.clearTimeout(timer);
    }
    // 已經是這個錢包、也在對的鏈上：不重做。Privy 的 `wallets` 陣列常常換新，照做會讓整個 app 一直重畫。
    const store = useWallet.getState();
    if (
      match.chainId === `eip155:${CHAIN_ID}` &&
      store.kind === 'injected' &&
      store.provider !== null &&
      sameAddress(store.address, match.address)
    ) {
      setSigner('ready');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // 先切到 app 的鏈再拿 provider（Privy：切鏈後要重新拿 provider 才是新鏈的）。切不動不擋連線。
        await match.switchChain(CHAIN_ID).catch(() => undefined);
        const provider = (await match.getEthereumProvider()) as unknown as Eip1193Provider;
        if (cancelled) return;
        const embedded = match.walletClientType === 'privy' || match.walletClientType === 'privy-v2';
        useWallet.getState().connectInjected({
          address: match.address,
          rdns: embedded ? PRIVY_EMBEDDED_RDNS : match.meta.id,
          provider,
        });
        setSigner('ready');
      } catch {
        if (!cancelled) setSigner('missing');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner, wallets, walletsReady]);

  // 保險：Privy 的 session 存在時，store 裡不可以出現主人以外的錢包（不論是誰放進去的）。
  useEffect(
    () =>
      useWallet.subscribe((state) => {
        const current = useSession.getState();
        if (current.via !== 'privy' || state.kind !== 'injected' || state.address === null) return;
        if (!sameAddress(state.address, current.address)) state.disconnect();
      }),
    [],
  );

  // ---- 動作 ------------------------------------------------------------------------------------
  const actions = useMemo<PrivyActions>(
    () => ({
      loginWithOAuth: async (provider) => {
        setOauthError(null);
        try {
          await initOAuth({ provider });
        } catch (cause) {
          setOauthError(cause);
        }
      },
      sendEmailCode: async (email) => {
        await sendCode({ email }).catch(() => undefined); // 錯誤由 emailState 帶出
      },
      submitEmailCode: async (code) => {
        await loginWithCode({ code }).catch(() => undefined);
      },
      loginWithWallet: () => login({ loginMethods: ['wallet'] }),
      logout: async () => {
        exchange.cancel();
        useSession.getState().clear();
        const wallet = useWallet.getState();
        if (wallet.kind === 'injected') wallet.disconnect();
        await logout();
      },
      retry: () => {
        // 撤銷還掛著的那一次，重試用新的請求。
        exchange.cancel();
        autoRetries.current = 0;
        refreshedFor.current = null;
        // 帳號上還沒有錢包（自動建立沒成功）就明確建一個；有的話請 Privy 重發 identity token。
        if (latest.current.accountWallets.length === 0) void createWallet().catch(() => undefined);
        else void refreshUser().catch(() => undefined);
        setFailure(null);
        setAttempt((count) => count + 1);
      },
      link: (kind: SignInMethodKind) => {
        // 首次拿到 CRE8 session 之前不可以加綁：後端要靠「帳號上恰好一個錢包」認定主人（backend#63）。
        if (!latest.current.privySession) return;
        usePrivyAuth.setState({ linkError: null });
        if (kind === 'email') linkEmail();
        else if (kind === 'google') linkGoogle();
        else if (kind === 'x') linkTwitter();
        else linkWallet();
      },
      connectOwnerWallet: () => connectWallet(),
      exportWallet: async () => {
        const address = useSession.getState().address;
        await exportWallet(address === null ? undefined : { address });
      },
    }),
    [login, logout, createWallet, refreshUser, linkEmail, linkGoogle, linkTwitter, linkWallet, connectWallet, exportWallet, initOAuth, sendCode, loginWithCode, exchange],
  );

  // ---- 同步到給畫面用的 store ------------------------------------------------------------------
  const phase: PrivyPhase = initError !== null && initError !== undefined && !ready
    ? 'unavailable'
    : !ready
    ? 'loading'
    : !authenticated
      ? 'signed-out'
      : privySession || otherSession
        ? 'signed-in'
        : failure !== null
          ? 'error'
          : accountWallets.length === 0
            ? 'creating-wallet'
            : 'exchanging';
  const methods = useMemo(() => signInMethods(accounts), [accounts]);
  const profile = useMemo(() => profileOf(accounts), [accounts]);
  const ownerEmbedded = owner !== null && accountWallets.some((wallet) => wallet.embedded && sameAddress(wallet.address, owner));
  useEffect(() => {
    usePrivyAuth.setState({
      phase,
      error: phase === 'unavailable' ? initError : failure,
      methods,
      profile,
      ownerEmbedded,
      signer,
      emailStep: emailState.status,
      emailError: emailState.status === 'error' ? emailState.error : null,
      oauthError,
      actions,
    });
  }, [phase, failure, initError, methods, profile, ownerEmbedded, signer, emailState, oauthError, actions]);
  // 登入完成（Privy 那一側）就把登入頁收起來；後面換 CRE8 session 的進度在標頭的選單裡。
  useEffect(() => {
    if (authenticated) usePrivyAuth.setState({ signInOpen: false, signInFor: null });
  }, [authenticated]);
  useEffect(() => () => usePrivyAuth.setState(PRIVY_INITIAL), []);

  return null;
}

export default function PrivyRoot(): ReactNode {
  // 測試網用測試網自己的節點（`CHAIN.rpcUrl`），不拿主網的 `VITE_RPC_URL`（cre8-app#93）。
  const chain = useMemo(() => privyChain(CHAIN_ID, CHAIN.testnet ? CHAIN.rpcUrl : import.meta.env.VITE_RPC_URL), []);
  if (PRIVY_APP_ID === null) return null;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: [...PRIVY_LOGIN_METHODS],
        // 只幫沒有錢包的人建錢包：錢包登入的人不會多一個嵌入式錢包（後端要求首次登入恰好一個錢包）。
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        defaultChain: chain,
        supportedChains: [chain],
        appearance: {
          theme: 'light',
          accentColor: '#0c1722',
          landingHeader: 'Sign in to CRE8',
          showWalletLoginFirst: false,
          walletChainType: 'ethereum-only',
        },
      }}
    >
      <Bridge />
    </PrivyProvider>
  );
}
