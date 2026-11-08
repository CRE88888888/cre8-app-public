import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { connectProvider, discoverProviders } from '../lib/wallet';
import { shortAddress } from '../lib/format';
import { useSession } from '../store/session';
import { useWallet } from '../store/wallet';
import { Badge } from './ui';

/**
 * CRE8 字標：`CRE` + 一個滾動的骰子轉盤停在 8。
 *
 * 這是原站的 `.c8-logo`（純 HTML + CSS，見 design.css 的 `c8roll` keyframes）。原本我們只印了
 * 「CRE8 · ATP」這段文字 —— 那正是「logo 消失」的原因：樣式一直都在，缺的是這段 markup。
 *
 * 轉盤的 9 個 `<i>` 是必要的：`.c8-reel` 的靜態 transform 停在 `-8.952em`，那剛好是第 9 個
 * 數字（8）的位置；少一個就會停在別的數字上。
 */
function C8Logo(): ReactNode {
  return (
    <span className="c8-logo" role="img" aria-label="CRE8">
      <span className="c8-cre" aria-hidden="true">
        CRE
      </span>
      <span className="c8-tile" aria-hidden="true">
        <span className="c8-win">
          <span className="c8-reel">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((digit) => (
              <i key={digit}>{digit}</i>
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * 標頭的「Connect wallet」。
 *
 * 行為分成兩種：
 *   * 只偵測到一個錢包 → 直接連（最少點擊）。
 *   * 偵測到多個 → 帶去 `/login` 讓使用者選（並順便在那裡完成 SIWE）。
 */
function ConnectWalletButton(): ReactNode {
  const navigate = useNavigate();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const providers = await discoverProviders();
      if (providers.length === 0) {
        navigate('/login');
        return;
      }
      if (providers.length > 1) {
        navigate('/login');
        return;
      }
      const detail = providers[0];
      if (detail === undefined) return;
      const address = await connectProvider(detail.provider);
      wallet.connectInjected({ address, rdns: detail.info.rdns, provider: detail.provider });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [navigate, wallet]);

  if (wallet.address !== null) {
    return (
      <button type="button" className="btn sm header-wallet" onClick={() => wallet.disconnect()}>
        <span className="mono">{shortAddress(wallet.address)}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn sm header-wallet"
      disabled={busy}
      title={error ?? undefined}
      onClick={() => void connect()}
    >
      {busy ? 'Detecting…' : 'Connect wallet'}
    </button>
  );
}

/**
 * 標頭。刻意照原站的 markup 寫（`header.masthead.app-masthead > .wrap`），因為樣式全在 `design.css` 裡：
 * 換掉結構就會掉樣式 —— 這是這一輪「UI 看起來不像原站」最主要的原因。
 *
 * 導覽只放**真的有頁面**的兩項。原站還有 `CRE8 AI` 與 `Leaderboard`，我們沒有那兩個頁面；
 * 放上去就是死連結，比少一個項目更糟。
 */
export function TopBar(): ReactNode {
  const token = useSession((state) => state.token);

  return (
    <header className="masthead app-masthead">
      <div className="wrap">
        <Link className="brand" to="/vaults" aria-label="CRE8 home">
          <C8Logo />
        </Link>

        <nav className="nav" aria-label="Main navigation">
          <NavLink to="/vaults" className={({ isActive }) => (isActive ? 'active' : '')}>
            Funds
          </NavLink>
          <NavLink to="/create" className={({ isActive }) => (isActive ? 'active' : '')}>
            Create fund
          </NavLink>
        </nav>

        <div className="head-right">
          <NavLink to="/portfolios" className={({ isActive }) => `head-link ${isActive ? 'active' : ''}`}>
            Portfolio
          </NavLink>
          {token === null ? null : (
            <Badge tone="ok" >
              Signed in
            </Badge>
          )}
          <ConnectWalletButton />
        </div>
      </div>
    </header>
  );
}
