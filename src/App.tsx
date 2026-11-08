import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PhaseBanner } from './components/PhaseBanner';
import { RequireSession } from './components/RequireSession';
import { TopBar } from './components/TopBar';
import { LoginPage } from './features/auth/LoginPage';
import { PortfoliosPage } from './features/portfolios/PortfoliosPage';
import { CreateFundPage } from './features/create/CreateFundPage';
import { VaultsPage } from './features/vaults/VaultsPage';
import { StatusPage } from './features/status/StatusPage';

export function App(): ReactNode {
  return (
    <>
      <PhaseBanner />
      <TopBar />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* 首頁改成 vaults：那是使用者進來的第一個畫面（Explore funds）。 */}
        <Route path="/" element={<VaultsPage />} />
        <Route path="/vaults" element={<VaultsPage />} />
        <Route path="/create" element={<CreateFundPage />} />
        {/* 舊的「只有列表」頁保留：它比 vaults 更適合 debug（沒有範例資料）。 */}
        <Route
          path="/portfolios"
          element={
            <RequireSession>
              <PortfoliosPage />
            </RequireSession>
          }
        />
        <Route
          path="/portfolios/:id"
          element={
            <RequireSession>
              <StatusPage />
            </RequireSession>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
