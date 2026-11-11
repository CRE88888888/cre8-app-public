import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { AppIcon, type AppTab } from './AppIcon';
import { WalletMenu } from './WalletMenu';
import { useMobile } from '../lib/use-mobile';

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

// 順序依使用頻率：先看基金，再看 creator，建立放中間，個人資產與管理放右側（拇指最常落在左半）。
const mobileDestinations: { to: string; label: string; icon: AppTab; paths: string[] }[] = [
  { to: '/vaults', label: 'Funds', icon: 'explore', paths: ['/vaults', '/funds', '/vault', '/assets', '/asset'] },
  { to: '/leaderboard', label: 'Creators', icon: 'creators', paths: ['/leaderboard', '/creator'] },
  { to: '/create', label: 'Create', icon: 'create', paths: ['/create'] },
  { to: '/portfolios', label: 'Portfolio', icon: 'portfolio', paths: ['/portfolios', '/portfolio'] },
  { to: '/operator', label: 'Manage', icon: 'manage', paths: ['/operator', '/rebalance', '/strategies'] },
];

/**
 * 各分頁根目錄在手機上的標題。這些頁面由頁面自己的 h1 當「大標題」，頂部列只放錢包；
 * 捲過大標題後頂部列才出現小標題與毛玻璃底，跟原生 App 的導覽列一樣。
 */
const tabRootTitles: Record<string, string> = {
  '/vaults': 'Funds',
  '/leaderboard': 'Creators',
  '/create': 'Create a fund',
  '/portfolio': 'Portfolio',
  '/portfolios': 'Portfolio',
  '/operator': 'Manage',
};

/** 捲過大標題（約 56px）才算「已捲動」；用 passive listener，不擋捲動。 */
function useScrolledPast(threshold: number, enabled: boolean): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setScrolled(window.scrollY > threshold);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [threshold, enabled]);
  return enabled && scrolled;
}

export function TopBar(): ReactNode {
  const { pathname } = useLocation();
  const mobile = useMobile();
  const rootTitle = mobile ? tabRootTitles[pathname.replace(/\/$/, '') || '/'] : undefined;
  const scrolled = useScrolledPast(56, rootTitle !== undefined);
  return (
    <>
      {rootTitle !== undefined ? (
        <header className="app-nav-bar" data-scrolled={scrolled ? 'true' : 'false'}>
          <span className="app-nav-bar-title" aria-hidden={!scrolled}>{rootTitle}</span>
          <WalletMenu iconOnly />
        </header>
      ) : (
        <header className="masthead app-masthead">
          <div className="wrap">
            <a className="brand" href="/" aria-label="CRE8 home">
              <C8Logo />
            </a>

            <nav className="nav" aria-label="Main navigation">
              <NavLink to="/vaults" className={({ isActive }) => (isActive || pathname.startsWith('/funds/') ? 'active' : '')}>
                Funds
              </NavLink>
              <NavLink to="/leaderboard" className={({isActive})=>isActive||pathname.startsWith('/creator/')?'active':''}>Creators</NavLink>
              <NavLink to="/create" className={({ isActive }) => (isActive ? 'active' : '')}>
                Create fund
              </NavLink>
              <NavLink to="/operator" className={({ isActive }) => (isActive ? 'active' : '')}>
                Manage
              </NavLink>
            </nav>

            <div className="head-right">
              <NavLink to="/portfolios" className={({ isActive }) => `head-link ${isActive ? 'active' : ''}`}>
                Portfolio
              </NavLink>
              <WalletMenu iconOnly={mobile} />
            </div>
          </div>
        </header>
      )}
      <nav className="app-mobile-nav" aria-label="Main navigation">
        {mobileDestinations.map(({ to, label, icon, paths }) => {
          const active = (to === '/vaults' && pathname === '/') ||
            paths.some((path) => pathname === path || pathname.startsWith(path + '/'));
          return (
            <Link key={to} to={to} aria-current={active ? 'page' : undefined}>
              <AppIcon name={icon} active={active} size={23} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
