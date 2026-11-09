import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { connectProvider, discoverProviders, ensureChain } from '../lib/wallet';
import { CHAIN_ID } from '../lib/kernel';
import type { ProviderDetail } from '../lib/wallet';
import { shortAddress } from '../lib/format';
import { useSession } from '../store/session';
import { useWallet } from '../store/wallet';
import { siwePhaseLabel, useSiweSignIn } from '../features/auth/use-siwe-signin';
import { useWalletDiagnostics } from '../lib/use-wallet-diagnostics';
import { ErrorNote } from './ui';

/** 任何地方都可以叫出錢包選單（例如 `RequireSession` 的「Sign in」）。 */
export const OPEN_WALLET_MENU = 'cre8:open-wallet-menu';

export function openWalletMenu(): void {
  window.dispatchEvent(new Event(OPEN_WALLET_MENU));
}

/**
 * 標頭的錢包選單。**取代了原本的 `/login` 整頁**。
 *
 * 為什麼改成下拉：登入其實只有兩個決策（哪個錢包、要不要簽名），而整頁把使用者帶離他正在看的
 * 內容。下拉的狀態機刻意寫死在這裡，因為「現在卡在哪一步」是使用者最需要看到的資訊：
 *
 *   錢包未連 → 列出偵測到的 EIP-6963 錢包（+ DEV build 的私鑰入口）
 *   已連未登入 → `Sign in with SIWE` 按鈕與它的三個階段（取 nonce / 等簽名 / 換 token）
 *   已登入 → 位址、`Signed in`、Portfolio 連結、Sign out
 */
export function WalletMenu(): ReactNode {
  const wallet = useWallet();
  const token = useSession((state) => state.token);
  const clearSession = useSession((state) => state.clear);

  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderDetail[] | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<unknown>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const siwe = useSiweSignIn(() => setOpen(false));
  // 錢包讀的是它自己的 RPC，所以「餘額不足」常常是連錯網路（chain 56 有兩個：主網與我們的 fork）。
  const diagnostics = useWalletDiagnostics(wallet.address, wallet.provider);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await discoverProviders());
    } catch (cause) {
      setConnectError(cause);
    }
  }, []);

  // 打開時才偵測：EIP-6963 是擴充功能主動廣播，關著的時候沒有理由一直問。
  useEffect(() => {
    if (open && providers === null) void refreshProviders();
  }, [open, providers, refreshProviders]);

  // 外面點一下、按 Esc 都要關掉（下拉選單的基本期待）。
  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  // 深連結：`/#wallet` 直接打開選單。支援文件可以指向這個錨點，截圖/驗證也不必先模擬點擊。
  useEffect(() => {
    if (window.location.hash === '#wallet') setOpen(true);
  }, []);

  // 別的頁面（RequireSession / vaults 的「Sign in」）也能叫出這個選單。
  useEffect(() => {
    const onOpen = (): void => setOpen(true);
    window.addEventListener(OPEN_WALLET_MENU, onOpen);
    return () => window.removeEventListener(OPEN_WALLET_MENU, onOpen);
  }, []);

  const connect = useCallback(
    async (detail: ProviderDetail) => {
      setConnecting(detail.info.rdns);
      setConnectError(null);
      try {
        const address = await connectProvider(detail.provider);

        // 連上之後**主動把錢包切到我們的鏈**。
        //
        // 不做這件事的實際後果：使用者上次測試時加了「CRE8 Local (1337)」網路，
        // 之後打開主網網站，畫面像「連到測試網」，每個讀取都失敗，而訊息完全看不出原因。
        // 切不動（使用者按取消）就照常連上，由 wallet-warning 告訴他鏈不對。
        try {
          await ensureChain(detail.provider, CHAIN_ID, {
            chainName: 'BNB Smart Chain',
            rpcUrls: [import.meta.env.VITE_RPC_URL ?? 'https://bsc-dataseed.binance.org'],
            nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
            blockExplorerUrls: ['https://bscscan.com'],
          });
        } catch {
          // 切鏈失敗不該擋住連線。
        }

        wallet.connectInjected({ address, rdns: detail.info.rdns, provider: detail.provider });
      } catch (cause) {
        setConnectError(cause);
      } finally {
        setConnecting(null);
      }
    },
    [wallet],
  );

  const label =
    token !== null && wallet.address !== null
      ? shortAddress(wallet.address)
      : wallet.address !== null
        ? 'Sign in'
        : 'Connect wallet';

  return (
    <div className="wallet-menu" ref={rootRef}>
      <button
        type="button"
        className="btn sm header-wallet"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>

      {open ? (
        <div className="wallet-menu__panel" role="menu">
          {wallet.address !== null && diagnostics.problem !== null ? (
        <p className="wallet-warning" role="alert" style={{ margin: '0 0 10px', fontSize: 12, lineHeight: 1.5 }}>
          {diagnostics.problem}
        </p>
      ) : null}

      {wallet.address === null ? (
            <>
              <p className="wallet-menu__title">Connect a wallet</p>
              {providers === null ? (
                <p className="wallet-menu__hint">Detecting wallets…</p>
              ) : providers.length === 0 ? (
                <p className="wallet-menu__hint">
                  No EIP-6963 wallet detected. Install a browser wallet, or reload the page if one is already
                  installed.
                </p>
              ) : (
                providers.map((detail) => (
                  <button
                    key={detail.info.rdns}
                    type="button"
                    className="wallet-menu__item"
                    role="menuitem"
                    disabled={connecting !== null}
                    onClick={() => void connect(detail)}
                  >
                    {detail.info.icon === undefined ? null : <img src={detail.info.icon} alt="" />}
                    <span>{detail.info.name}</span>
                    {connecting === detail.info.rdns ? <span className="wallet-menu__hint">Connecting…</span> : null}
                  </button>
                ))
              )}
              <ErrorNote error={connectError} />
            </>
          ) : token === null ? (
            <>
              <p className="wallet-menu__title">Sign in with SIWE</p>
              <p className="wallet-menu__hint">
                Session-key permissions live on-chain; signing in only proves to the backend that this wallet owns
                the account. EIP-4361, no transaction, no gas.
              </p>
              <p className="wallet-menu__addr mono">{shortAddress(wallet.address)}</p>
              <button
                type="button"
                className="btn sm"
                disabled={siwe.phase !== 'idle'}
                onClick={() => void siwe.signIn()}
              >
                {siwePhaseLabel(siwe.phase)}
              </button>
              <ErrorNote error={siwe.error} />
              <button type="button" className="wallet-menu__link" onClick={() => wallet.disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              <p className="wallet-menu__addr mono">{shortAddress(wallet.address)}</p>
              <p className="wallet-menu__status">Signed in</p>
              <Link className="wallet-menu__item" to="/portfolios" onClick={() => setOpen(false)}>
                Portfolio
              </Link>
              <button
                type="button"
                className="wallet-menu__link"
                onClick={() => {
                  clearSession();
                  setOpen(false);
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

/** 頁面上的「Sign in」——不是連到某一頁，而是叫出標頭那個選單（單一入口）。 */
export function SignInButton({ children }: { children?: ReactNode }): ReactNode {
  return (
    <button type="button" className="link-button" onClick={() => openWalletMenu()}>
      {children ?? 'Sign in'}
    </button>
  );
}
