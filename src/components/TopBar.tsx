import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { AppIcon, type AppIconName } from './AppIcon';
import { WalletMenu } from './WalletMenu';
import { ThemeToggle } from './ThemeToggle';
import { useMobile } from '../lib/use-mobile';
import { useMastheadHeight } from '../lib/masthead-height';

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

type Destination = { to: string; label: string; icon: AppIconName; paths: string[] };

/**
 * 導覽只剩逛基金與個人頁。建立基金、Studio 與 Creators 分頁已拿掉（基金只由平台上架，cre8-app#123）。
 */
const destinations: Destination[] = [
  { to: '/vaults', label: 'Funds', icon: 'explore', paths: ['/vaults', '/funds', '/vault', '/assets', '/asset'] },
  { to: '/portfolios', label: 'Profile', icon: 'profile', paths: ['/portfolios', '/portfolio'] },
];

function isActive({ paths }: Destination, pathname: string): boolean {
  return paths.some((path) => pathname === path || pathname.startsWith(path + '/'));
}

/**
 * 各分頁根目錄在手機上的標題。這些頁面由頁面自己的 h1 當「大標題」，頂部列只放錢包；
 * 捲過大標題後頂部列才出現小標題，跟原生 App 的導覽列一樣。
 */
const tabRootTitles: Record<string, string> = {
  // 首頁就是 Funds（main 的 6565628 讓 Pages 首頁直接開 Explore）。
  '/': 'Funds',
  '/vaults': 'Funds',
  '/portfolio': 'Profile',
  '/portfolios': 'Profile',
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
  const path = pathname.replace(/\/$/, '') || '/';
  const rootTitle = mobile ? tabRootTitles[path] : undefined;
  const scrolled = useScrolledPast(56, rootTitle !== undefined);
  const masthead = useRef<HTMLElement>(null);
  useMastheadHeight(masthead);

  return (
    <>
      {rootTitle !== undefined ? (
        <header className="app-nav-bar" data-scrolled={scrolled ? 'true' : 'false'}>
          <span className="app-nav-bar-title" aria-hidden={!scrolled}>{rootTitle}</span>
          <div className="app-nav-bar-actions">
            <WalletMenu iconOnly />
          </div>
        </header>
      ) : (
        <header ref={masthead} className="masthead app-masthead">
          <div className="wrap">
            <a className="brand" href="/" aria-label="CRE8 home">
              <C8Logo />
            </a>

            <nav className="nav" aria-label="Main navigation">
              {destinations.map((destination) => (
                <NavLink key={destination.to} to={destination.to}
                  className={() => (isActive(destination, path) || (destination.to === '/vaults' && path === '/') ? 'active' : '')}>
                  {destination.label}
                </NavLink>
              ))}
            </nav>

            <div className="head-right">
              {!mobile && <ThemeToggle />}
              <WalletMenu iconOnly={mobile} />
            </div>
          </div>
        </header>
      )}
      <nav className="app-mobile-nav" aria-label="Main navigation" data-count={destinations.length}>
        {destinations.map((destination) => {
          const active = (destination.to === '/vaults' && path === '/') || isActive(destination, path);
          return (
            <Link key={destination.to} to={destination.to} aria-current={active ? 'page' : undefined}>
              <AppIcon name={destination.icon} active={active} size={23} />
              <span>{destination.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
