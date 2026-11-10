import {lazy,Suspense,useEffect,useSyncExternalStore} from 'react';
import {refreshReferenceData,subscribeReference,referenceRevision} from './lib/reference-refresh';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PhaseBanner } from './components/PhaseBanner';
import { Toaster } from './components/Toast';
import { RequireSession } from './components/RequireSession';
import { TopBar } from './components/TopBar';
import { useAutoConnect } from './lib/use-auto-connect';
import { useAccountWatch } from './lib/use-account-watch';
import { FundPage } from './features/fund/FundPage';
import { OperatorPage } from './features/operator/OperatorPage';
import { StrategyPage } from './features/strategy/StrategyPage';
import { PortfoliosPage } from './features/portfolios/PortfoliosPage';
const DesignFundPage=lazy(()=>import('./features/create/DesignFundPage').then(module=>({default:module.DesignFundPage})));
const ActivateFundPage=lazy(()=>import('./features/create/CreateFundPage').then(module=>({default:module.ActivateFundPage})));
import {CreatorPage} from './features/reference/CreatorPage';
import { Leaderboard } from './features/reference/Leaderboard';
const AssetPage=lazy(()=>import('./features/reference/AssetPage').then(module=>({default:module.AssetPage})));
import { VaultsPage } from './features/vaults/VaultsPage';

export function App(): ReactNode {
  useSyncExternalStore(subscribeReference,referenceRevision,referenceRevision);
  useEffect(()=>{void refreshReferenceData();},[]);
  // 重新整理後自動接回先前授權過的錢包（`eth_accounts` 不彈窗）。
  useAutoConnect();
  useAccountWatch();
  return (
    <>
      <Toaster />
      <PhaseBanner />
      <TopBar />
      <Suspense fallback={<main className="page"><p role="status">Loading page…</p></main>}>
      <Routes>
        {/* 登入改由標頭的錢包選單處理；舊連結仍然可用，只是把使用者帶回目錄。 */}
        <Route path="/login" element={<Navigate to="/vaults" replace />} />
        {/* 首頁改成 vaults：那是使用者進來的第一個畫面（Explore funds）。 */}
        <Route path="/" element={<VaultsPage />} />
        <Route path="/vaults" element={<VaultsPage />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/creator/:id" element={<CreatorPage />} />
        <Route path="/portfolio" element={<PortfoliosPage />} />
        <Route path="/create" element={<DesignFundPage />} />
        <Route path="/create/activate" element={<ActivateFundPage />} />
        <Route path="/operator" element={<OperatorPage />} />
        <Route path="/strategies/:id" element={<StrategyPage />} />
        <Route path="/funds/:slug" element={<FundPage />} />
        <Route path="/vault/:slug" element={<FundPage />} />
        <Route path="/asset/:slug" element={<AssetPage />} />
        <Route path="/assets/:slug" element={<AssetPage />} />
        {/* 舊的「只有列表」頁保留：它比 vaults 更適合 debug（沒有範例資料）。 */}
        <Route
          path="/portfolios"
          element={
            <RequireSession>
              <PortfoliosPage />
            </RequireSession>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </>
  );
}
