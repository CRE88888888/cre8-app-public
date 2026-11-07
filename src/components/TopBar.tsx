import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { shortAddress } from '../lib/format';
import { useSession } from '../store/session';
import { useWallet } from '../store/wallet';
import { Badge } from './ui';

export function TopBar(): ReactNode {
  const address = useSession((state) => state.address);
  const token = useSession((state) => state.token);
  const walletAddress = useWallet((state) => state.address);
  const clearSession = useSession((state) => state.clear);
  const disconnectWallet = useWallet((state) => state.disconnect);
  const navigate = useNavigate();

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <Link className="brand" to="/">
          CRE8 · ATP
        </Link>
        <div className="row">
          {address === null ? (
            <span className="muted">未登入</span>
          ) : (
            <>
              <span className="mono" title={address}>
                {shortAddress(address)}
              </span>
              <Badge tone={token === null ? 'warn' : 'ok'}>{token === null ? '無 token' : '已登入'}</Badge>
              {/* 登入（token）與錢包連線是兩件事：前者存 sessionStorage、後者只在記憶體。
                  兩者不一致時要看得出來，否則「為什麼不能簽名」會變成一個謎。 */}
              {token !== null && walletAddress === null ? <Badge tone="warn">錢包未連</Badge> : null}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  clearSession();
                  disconnectWallet();
                  navigate('/login');
                }}
              >
                登出
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
