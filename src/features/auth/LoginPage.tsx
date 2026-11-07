import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { createSiweMessage } from 'viem/siwe';
import type { Address } from 'viem';
import { postLogin, postNonce } from '../../lib/api';
import { signWithProvider } from '../../lib/wallet';
import { useSession } from '../../store/session';
import { useWallet } from '../../store/wallet';
import { WalletConnect } from '../../components/WalletConnect';
import { ErrorNote, Note, Spinner } from '../../components/ui';

export function LoginPage(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useSession((state) => state.setSession);
  const wallet = useWallet();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const nextPath = ((): string => {
    const state = location.state as { from?: unknown } | null;
    return typeof state?.from === 'string' ? state.from : '/';
  })();

  const signIn = useCallback(async () => {
    if (wallet.address === null) return;
    setError(null);
    try {
      setBusy('取得 challenge…');
      const challenge = await postNonce();

      const message = createSiweMessage({
        address: wallet.address as Address,
        chainId: challenge.chainId,
        domain: challenge.domain,
        nonce: challenge.nonce,
        uri: challenge.uri,
        statement: challenge.statement,
        version: '1',
        issuedAt: new Date(challenge.issuedAt),
        expirationTime: new Date(challenge.expiresAt),
      });

      setBusy('在錢包裡簽名…');
      const signature =
        wallet.kind === 'dev' && wallet.devSigner !== null
          ? await wallet.devSigner.signMessage(message)
          : wallet.provider === null
            ? (() => {
                throw new Error('錢包連線掉了，請重新連線');
              })()
            : await signWithProvider(wallet.provider, wallet.address, message);

      setBusy('換 token…');
      const credentials = await postLogin(message, signature);
      setSession({ token: credentials.token, expiresAt: credentials.expiresAt, address: wallet.address });
      navigate(nextPath, { replace: true });
    } catch (cause) {
      // 使用者按「取消」也是走這裡 —— 錢包會 throw，不該當成 app 壞掉。
      setError(cause);
    } finally {
      setBusy(null);
    }
  }, [navigate, nextPath, setSession, wallet]);

  const canSign = wallet.address !== null && busy === null;

  return (
    <main className="page stack">
      <div>
        <p className="eyebrow">登入</p>
        <h1>CRE8 ATP</h1>
        <p className="lead">
          session key 的權限在鏈上，登入只是為了讓後端知道「你是這個帳戶的擁有者」。簽名用 EIP-4361（SIWE），
          內容包含 domain、chainId 與一次性 nonce。
        </p>
      </div>

      <section className="card stack">
        <div>
          <p className="eyebrow">步驟 1</p>
          <h2>連線錢包</h2>
        </div>
        <WalletConnect />
      </section>

      <section className="card stack">
        <div>
          <p className="eyebrow">步驟 2</p>
          <h2>SIWE 登入</h2>
        </div>
        <button type="button" className="btn btn--primary" disabled={!canSign} onClick={() => void signIn()}>
          {busy ?? (wallet.address === null ? '先連線錢包' : '簽名並登入')}
        </button>
        {busy === null ? null : (
          <div className="row">
            <Spinner /> <span className="muted">{busy}</span>
          </div>
        )}
        {wallet.address === null ? (
          <Note>登入狀態會存在 sessionStorage；錢包連線不會跨重新整理（provider 不是可序列化的資料）。</Note>
        ) : null}
        <ErrorNote error={error} />
      </section>
    </main>
  );
}
