import type { ReactNode } from 'react';
import { sessionIsLive, useSession } from '../store/session';
import { SignInButton } from './WalletMenu';
import { Note } from './ui';

/**
 * 沒有有效 session 時不跳頁，就地請使用者登入。
 *
 * 原本是 `Navigate to="/login"`，但登入已經變成標頭的下拉選單 —— 把人帶離他正在看的頁面
 * 只是為了按一顆按鈕，然後還要再導回來。這裡直接給一個「叫出選單」的按鈕，
 * 使用者的位置不會掉。
 */
export function RequireSession({ children }: { children: ReactNode }): ReactNode {
  const token = useSession((state) => state.token);
  const expiresAt = useSession((state) => state.expiresAt);

  if (!sessionIsLive({ token, expiresAt })) {
    return (
      <main className="page stack">
        <Note tone="warn">
          <strong>Sign in required</strong>
          <div style={{ marginTop: 6 }}>
            Connect a wallet and sign in with SIWE to see this page. <SignInButton /> opens the wallet menu in the
            header.
          </div>
        </Note>
      </main>
    );
  }
  return <>{children}</>;
}
