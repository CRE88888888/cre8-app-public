import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { sessionIsLive, useSession } from '../store/session';

/** 沒有有效 token 就回登入頁；登入後回到原本想去的路徑。 */
export function RequireSession({ children }: { children: ReactNode }): ReactNode {
  const token = useSession((state) => state.token);
  const expiresAt = useSession((state) => state.expiresAt);
  const location = useLocation();

  if (!sessionIsLive({ token, expiresAt })) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
