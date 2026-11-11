import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { isCre8CreatorWallet } from '../lib/creators';
import { useWallet } from '../store/wallet';
import { WalletMenu } from './WalletMenu';

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

export function TopBar(): ReactNode {
  const { pathname } = useLocation();
  const showRebalance = useWallet((state) => isCre8CreatorWallet(state.address));
  return (
    <header className="masthead app-masthead">
      <div className="wrap">
        <Link className="brand" to="/vaults" aria-label="CRE8 home">
          <C8Logo />
        </Link>

        <nav className="nav" aria-label="Main navigation">
          <NavLink to="/vaults" className={({ isActive }) => (isActive || pathname.startsWith('/funds/') ? 'active' : '')}>
            Funds
          </NavLink>
          <NavLink to="/leaderboard" className={({isActive})=>isActive?'active':''}>Leaderboard</NavLink>
          <NavLink to="/create" className={({ isActive }) => (isActive ? 'active' : '')}>
            Create fund
          </NavLink>
          {showRebalance && (
            <NavLink to="/operator" className={({ isActive }) => (isActive ? 'active' : '')}>
              Rebalance
            </NavLink>
          )}
        </nav>

        <div className="head-right">
          <NavLink to="/portfolios" className={({ isActive }) => `head-link ${isActive ? 'active' : ''}`}>
            Portfolio
          </NavLink>
          <WalletMenu />
        </div>
      </div>
    </header>
  );
}
