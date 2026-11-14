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
import { PrivyProvider, useCreateWallet, useIdentityToken, usePrivy, useUser, useWallets } from '@privy-io/react-auth';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, postPrivyLogin } from '../../lib/api';
import { CHAIN_ID } from '../../lib/kernel';
import { PRIVY_APP_ID, PRIVY_EMBEDDED_RDNS, PRIVY_LOGIN_METHODS, privyChain } from '../../lib/privy-config';
import {
  PrivySetupError,
  evmWallets,
  identityTokenWallets,
  readRememberedOwner,
  rememberOwner,
  resolveOwner,
  sameAddress,
  signInMethods,
} from '../../lib/privy-owner';
import type { LinkedAccountLike, SignInMethodKind } from '../../lib/privy-owner';
import type { Eip1193Provider } from '../../lib/wallet';
import { PRIVY_INITIAL, usePrivyAuth } from '../../store/privy';
import type { PrivyActions, PrivyPhase } from '../../store/privy';
import { sessionIsLive, useSession } from '../../store/session';
import { useWallet } from '../../store/wallet';

/** 等嵌入式錢包建好、等 identity token 帶到它，最多等這麼久；超過就顯示錯誤與「再試一次」。 */
const SETUP_TIMEOUT_MS = 25_000;
/** Privy 回報「錢包已就緒」後，主人錢包仍沒出現多久才算「沒有」。避免剛載入時閃一下提示。 */
const SIGNER_GRACE_MS = 3_000;
/** 後端回 `PRIVY_NO_WALLET`（token 還沒帶到剛建好的錢包）時，自動重試幾次。 */
const AUTO_RETRIES = 2;

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function Bridge(): null {
  const { ready, authenticated, user, error: initError, login, logout, connectWallet, linkEmail, linkGoogle, linkApple, linkWallet, exportWallet } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { identityToken } = useIdentityToken();
  const { refreshUser } = useUser();
  const { createWallet } = useCreateWallet();
  const session = useSession();

  const [failure, setFailure] = useState<unknown>(null);
  /** 只用來讓「換 session」的 effect 再跑一次。 */
  const [attempt, setAttempt] = useState(0);
  const [signer, setSigner] = useState<'checking' | 'ready' | 'missing'>('checking');
  const inFlight = useRef(false);
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
    const current = useSession.getState();
    if (current.via === 'privy') current.clear();
    const wallet = useWallet.getState();
    if (wallet.kind === 'injected') wallet.disconnect();
    setFailure(null);
    autoRetries.current = 0;
    refreshedFor.current = null;
  }, [ready, authenticated]);

  // ---- 換 CRE8 session ------------------------------------------------------------------------
  //
  // 順序是後端規則決定的（backend#65）：首次登入時帳號上要有**恰好一個** EVM 錢包。
  //   email／Google／Apple：Privy 登入完成 → Privy 建嵌入式錢包 → identity token 更新 → 才送。
  //   錢包登入：登入完成時那個錢包就在帳號上，直接送。
  // 在拿到 CRE8 session 之前，這個 app 不提供任何「加綁」的入口（見下面的 `link`）。
  useEffect(() => {
    if (!ready || !authenticated || userId === null || privySession || otherSession || failure !== null) return;
    if (inFlight.current) return;
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

    inFlight.current = true;
    void (async () => {
      try {
        const credentials = await postPrivyLogin(identityToken);
        // 等回應的期間使用者可能已經登出或換人：那就丟掉這份 session。
        if (latest.current.userId !== userId) return;
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
        if (cause instanceof ApiError && cause.code === 'PRIVY_NO_WALLET' && autoRetries.current < AUTO_RETRIES) {
          autoRetries.current += 1;
          await refreshUser().catch(() => undefined);
          await delay(1_500);
          setAttempt((count) => count + 1);
        } else {
          setFailure(cause);
        }
      } finally {
        inFlight.current = false;
      }
    })();
  }, [ready, authenticated, userId, privySession, otherSession, failure, accountWallets, identityToken, attempt, refreshUser]);

  // ---- 等太久：講清楚卡在哪裡，給「再試一次」 --------------------------------------------------
  const waitingFor = !ready || !authenticated || privySession || otherSession || failure !== null
    ? null
    : accountWallets.length === 0 ? 'wallet' : identityToken === null ? 'token' : 'exchange';
  useEffect(() => {
    if (waitingFor === null) return;
    const timer = window.setTimeout(() => {
      if (latest.current.privySession || inFlight.current) return;
      setFailure(new PrivySetupError(waitingFor === 'token' ? 'NO_IDENTITY_TOKEN' : 'NO_WALLET'));
    }, SETUP_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [waitingFor]);

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
      login: () => login(),
      logout: async () => {
        useSession.getState().clear();
        const wallet = useWallet.getState();
        if (wallet.kind === 'injected') wallet.disconnect();
        await logout();
      },
      retry: () => {
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
        if (kind === 'email') linkEmail();
        else if (kind === 'google') linkGoogle();
        else if (kind === 'apple') linkApple();
        else linkWallet();
      },
      connectOwnerWallet: () => connectWallet(),
      exportWallet: async () => {
        const address = useSession.getState().address;
        await exportWallet(address === null ? undefined : { address });
      },
    }),
    [login, logout, createWallet, refreshUser, linkEmail, linkGoogle, linkApple, linkWallet, connectWallet, exportWallet],
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
  const ownerEmbedded = owner !== null && accountWallets.some((wallet) => wallet.embedded && sameAddress(wallet.address, owner));
  useEffect(() => {
    usePrivyAuth.setState({ phase, error: phase === 'unavailable' ? initError : failure, methods, ownerEmbedded, signer, actions });
  }, [phase, failure, initError, methods, ownerEmbedded, signer, actions]);
  useEffect(() => () => usePrivyAuth.setState(PRIVY_INITIAL), []);

  return null;
}

export default function PrivyRoot(): ReactNode {
  const chain = useMemo(() => privyChain(CHAIN_ID, import.meta.env.VITE_RPC_URL), []);
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
