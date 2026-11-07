import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { connectProvider, discoverProviders } from '../lib/wallet';
import { shortAddress } from '../lib/format';
import { useSession } from '../store/session';
import { useWallet } from '../store/wallet';
import { Badge } from './ui';

/**
 * 標頭的「Connect wallet」。
 *
 * 行為刻意分成兩種：
 *   * 只偵測到一個錢包 → 直接連（最少點擊）。
 *   * 偵測到多個 → 帶去 `/login` 讓使用者選（並順便在那裡完成 SIWE）。
 * 把「連線」與「挑錢包」混在同一顆按鈕裡的做法（開一個 modal）需要更多狀態，而 `/login` 已經有了。
 */
function ConnectWalletButton(): ReactNode {
  const navigate = useNavigate();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const providers = await discoverProviders();
      if (providers.length === 0) {
        // 沒有 EIP-6963 錢包時不要假裝成功：把使用者送到登入頁，那裡有 dev 私鑰的入口（DEV build）。
        navigate('/login');
        return;
      }
      if (providers.length > 1) {
        navigate('/login');
        return;
      }
      const detail = providers[0];
      if (detail === undefined) return;
      const address = await connectProvider(detail.provider);
      wallet.connectInjected({ address, rdns: detail.info.rdns, provider: detail.provider });
      // 連上錢包不等於登入：SIWE 還是要走一次（token 是後端認人的依據）。
      navigate('/login');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [navigate, wallet]);

  return (
    <div className="row" style={{ gap: 8 }}>
      {error === null ? null : (
        <span className="neg" style={{ fontSize: 12 }} title={error}>
          連線失敗
        </span>
      )}
      <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void connect()}>
        {busy ? '偵測錢包…' : 'Connect wallet'}
      </button>
    </div>
  );
}

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
        <div className="row" style={{ gap: 20 }}>
          <Link className="brand" to="/vaults">
            CRE8 · ATP
          </Link>
          <nav className="row" style={{ gap: 14 }}>
            <NavLink
              to="/vaults"
              style={({ isActive }) => ({ fontSize: 14, opacity: isActive ? 1 : 0.6 })}
            >
              Vaults
            </NavLink>
            <NavLink
              to="/create"
              style={({ isActive }) => ({ fontSize: 14, opacity: isActive ? 1 : 0.6 })}
            >
              Create
            </NavLink>
          </nav>
        </div>

        <div className="row" style={{ gap: 12 }}>
          {walletAddress === null ? (
            <ConnectWalletButton />
          ) : (
            <span className="mono" style={{ fontSize: 13 }} title={walletAddress}>
              {shortAddress(walletAddress)}
            </span>
          )}

          {address === null ? null : (
            <>
              <Badge tone={token === null ? 'warn' : 'ok'}>{token === null ? '未登入' : '已登入'}</Badge>
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
