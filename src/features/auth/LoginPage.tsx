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
      setBusy('Fetching challenge…');
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

      setBusy('Signing in your wallet…');
      const signature =
        wallet.kind === 'dev' && wallet.devSigner !== null
          ? await wallet.devSigner.signMessage(message)
          : wallet.provider === null
            ? (() => {
                throw new Error('Wallet connection was lost — reconnect.');
              })()
            : await signWithProvider(wallet.provider, wallet.address, message);

      setBusy('Exchanging for a token…');
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
        <p className="eyebrow">Sign in</p>
        <h1>CRE8 ATP</h1>
        <p className="lead">
          Session-key permissions live on-chain; signing in just tells the backend you own this account. The signature is EIP-4361 (SIWE),
          carrying the domain, chainId and a single-use nonce.
        </p>
      </div>

      <section className="card stack">
        <div>
          <p className="eyebrow">Step 1</p>
          <h2>Connect a wallet</h2>
        </div>
        <WalletConnect />
      </section>

      <section className="card stack">
        <div>
          <p className="eyebrow">Step 2</p>
          <h2>Sign in with SIWE</h2>
        </div>
        <button type="button" className="btn btn--primary" disabled={!canSign} onClick={() => void signIn()}>
          {busy ?? (wallet.address === null ? 'Connect a wallet first' : 'Sign in')}
        </button>
        {busy === null ? null : (
          <div className="row">
            <Spinner /> <span className="muted">{busy}</span>
          </div>
        )}
        {wallet.address === null ? (
          <Note>The session is kept in sessionStorage; the wallet connection does not survive a reload (a provider is not serialisable).</Note>
        ) : null}
        <ErrorNote error={error} />
      </section>
    </main>
  );
}
