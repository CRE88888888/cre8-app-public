import {lazy,Suspense,useEffect,useSyncExternalStore} from 'react';
import {refreshReferenceData,subscribeReference,referenceRevision} from './lib/reference-refresh';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';

/** /strategies/:id → /funds/strategy/:id 的重導向（保留 id，交給 FundPage 的 id 模式）。 */
function StrategyRedirect(): ReactNode {
  const { id } = useParams<{ id: string }>();
  return <Navigate replace to={`/funds/strategy/${id ?? ''}`} />;
}
import { Toaster } from './components/Toast';
import { TopBar } from './components/TopBar';
import { PlatformPauseBanner } from './components/PlatformPauseBanner';
import { TestnetBanner, WrongNetworkNotice } from './components/NetworkBanners';
import { OwnerWalletNotice } from './components/PrivyWalletMenu';
import { SignInScreen } from './components/SignInScreen';
import { PrivyBoundary } from './features/auth/PrivyBoundary';
import { PRIVY_ENABLED } from './lib/privy-config';
import { useAutoConnect } from './lib/use-auto-connect';
import { useAccountWatch } from './lib/use-account-watch';
import { FundPage } from './features/fund/FundPage';
import { OperatorPage } from './features/operator/OperatorPage';
import { PortfoliosPage } from './features/portfolios/PortfoliosPage';
const AssetPage=lazy(()=>import('./features/reference/AssetPage').then(module=>({default:module.AssetPage})));
import { VaultsPage } from './features/vaults/VaultsPage';
import { WaitlistGate } from './features/waitlist/WaitlistScreen';

/**
 * Privy 登入（cre8-app#57）：只在有設定 `VITE_PRIVY_APP_ID` 時載入。
 *
 * 條件寫在 `lazy` 外面是刻意的：沒設定時這個動態 import 不存在於執行路徑上，Privy SDK 那一包
 * 不會被下載。不要改成靜態 import。它不包住 app（見 `PrivyRoot.tsx` 檔頭），所以放在旁邊就好。
 */
const PrivyRoot = PRIVY_ENABLED ? lazy(() => import('./features/auth/PrivyRoot')) : null;

export function App(): ReactNode {
  useSyncExternalStore(subscribeReference,referenceRevision,referenceRevision);
  useEffect(()=>{void refreshReferenceData();},[]);
  // 重新整理後自動接回先前授權過的錢包（`eth_accounts` 不彈窗）。
  useAutoConnect();
  useAccountWatch();
  const privy = PrivyRoot !== null && (
    <PrivyBoundary>
      <Suspense fallback={null}>
        <PrivyRoot />
      </Suspense>
    </PrivyBoundary>
  );
  // Waitlist（使用者 2026-11-16）：整站先鎖住，只有 Connect X 與 Follow。放行後 landing 網域換成 landing、app 網域照常。
  // 閘門是包住頁面的子元件：App 本身不訂閱登入狀態，否則每次狀態變動都會重繪 PrivyRoot（無限迴圈）。
  return (
    <>
      <Toaster />
      {privy}
      <WaitlistGate>
      <TopBar />
      <TestnetBanner />
      <WrongNetworkNotice />
      <PlatformPauseBanner />
      {PRIVY_ENABLED && <OwnerWalletNotice />}
      {PRIVY_ENABLED && <SignInScreen />}
      <Suspense fallback={<main className="page"><p role="status">Loading page…</p></main>}>
      <Routes>
        {/* 登入改由標頭的錢包選單處理；舊連結仍然可用，只是把使用者帶回目錄。 */}
        <Route path="/login" element={<Navigate to="/vaults" replace />} />
        <Route path="/" element={<VaultsPage />} />
        {/* manifest 的 start_url。原本會回到上次用的模式（投資／Studio）；Studio 已拿掉（cre8-app#123）。 */}
        <Route path="/start" element={<Navigate to="/vaults" replace />} />
        <Route path="/vaults" element={<VaultsPage />} />
        <Route path="/portfolio" element={<PortfoliosPage />} />
        {/* 基金只由平台上架（2026-11-19 產品說明 §3.2）：建立基金（/create*）、Studio（/studio*）、
            創作者頁（/creator/:id）與 /leaderboard 都拿掉了（cre8-app#123），舊網址交給最後的 * 回到 /vaults。 */}
        {/* 內部營運後台：不在任何導覽裡，保留網址給營運團隊。 */}
        <Route path="/operator" element={<OperatorPage />} />
        <Route path="/rebalance" element={<Navigate to="/operator" replace />} />
        {/* Community 策略的詳情頁：與 /funds/:slug 同一套版面（含下單 ticket）。
            /strategies/:id 重導向到這裡，FundPage 用 strategyId 進入 id 模式。 */}
        <Route path="/strategies/:id" element={<StrategyRedirect />} />
        <Route path="/funds/strategy/:id" element={<FundPage />} />
        <Route path="/funds/:slug" element={<FundPage />} />
        <Route path="/vault/:slug" element={<FundPage />} />
        <Route path="/asset/:slug" element={<AssetPage />} />
        <Route path="/assets/:slug" element={<AssetPage />} />
        <Route path="/portfolios" element={<PortfoliosPage />} />
        <Route path="*" element={<Navigate to="/vaults" replace />} />
      </Routes>
      </Suspense>
      </WaitlistGate>
    </>
  );
}
