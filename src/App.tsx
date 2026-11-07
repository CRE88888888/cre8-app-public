import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireSession } from './components/RequireSession';
import { TopBar } from './components/TopBar';
import { LoginPage } from './features/auth/LoginPage';
import { PortfoliosPage } from './features/portfolios/PortfoliosPage';
import { StatusPage } from './features/status/StatusPage';

export function App(): ReactNode {
  return (
    <>
      <TopBar />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
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
