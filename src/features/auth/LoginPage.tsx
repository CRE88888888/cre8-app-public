import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { createSiweMessage } from 'viem/siwe';
import type { Address, Hex } from 'viem';
import { ApiError, postLogin, postNonce } from '../../lib/api';
import {
  chainIdOf,
  connectProvider,
  createDevSigner,
  discoverProviders,
  isLikelyPrivateKey,
  signWithProvider,
} from '../../lib/wallet';
import type { DevSigner, ProviderDetail } from '../../lib/wallet';
import { shortAddress } from '../../lib/format';
import { useSession } from '../../store/session';
import { useWallet } from '../../store/wallet';
import { Badge, ErrorNote, Field, Note, Spinner } from '../../components/ui';

/** 本機 anvil 的 #3（sudo owner）。只在 DEV build 出現，且不寫入任何持久化儲存。 */
const DEV_KEY_HINT = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

export function LoginPage(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useSession((state) => state.setSession);
  const wallet = useWallet();

  const [providers, setProviders] = useState<ProviderDetail[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [devKey, setDevKey] = useState('');

  const nextPath = ((): string => {
    const state = location.state as { from?: unknown } | null;
    return typeof state?.from === 'string' ? state.from : '/';
  })();

  useEffect(() => {
    let alive = true;
    void discoverProviders().then((found) => {
      if (!alive) return;
      setProviders(found);
      setDiscovering(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const signIn = useCallback(
    async (account: string, sign: (message: string) => Promise<string>) => {
      setError(null);
      try {
        setBusy('取得 challenge…');
        const challenge = await postNonce();

        const message = createSiweMessage({
          address: account as Address,
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
        const signature = await sign(message);

        setBusy('換 token…');
        const credentials = await postLogin(message, signature);
        setSession({ token: credentials.token, expiresAt: credentials.expiresAt, address: account });
        navigate(nextPath, { replace: true });
      } catch (cause) {
        // 使用者按「取消」也是走這裡 —— 錢包會 throw，不該當成 app 壞掉。
        setError(cause);
      } finally {
        setBusy(null);
      }
    },
    [navigate, nextPath, setSession],
  );

  const connectInjected = useCallback(
    async (detail: ProviderDetail) => {
      setError(null);
      try {
        setBusy(`連線 ${detail.info.name}…`);
        const address = await connectProvider(detail.provider);
        const chainId = await chainIdOf(detail.provider).catch(() => null);
        wallet.connectInjected({ address, rdns: detail.info.rdns, provider: detail.provider });
        if (chainId !== null && chainId !== 56) {
          setError(
            new ApiError(
              0,
              'WRONG_CHAIN',
              `錢包在 chain ${chainId}，這個後端是 BSC 56。簽名本身還是會成功，但請確認你知道自己在哪條鏈上。`,
            ),
          );
        }
      } catch (cause) {
        setError(cause);
      } finally {
        setBusy(null);
      }
    },
    [wallet],
  );

  const connectDev = useCallback(() => {
    setError(null);
    if (!isLikelyPrivateKey(devKey)) {
      setError(new ApiError(0, 'BAD_DEV_KEY', '私鑰格式不對：需要 0x 加 64 個 hex'));
      return;
    }
    const signer: DevSigner = createDevSigner(devKey.trim() as Hex);
    wallet.connectDev(signer);
  }, [devKey, wallet]);

  const canSign = wallet.address !== null;

  return (
    <main className="page stack">
      <div>
        <p className="eyebrow">步驟 1 · 連線</p>
        <h1>登入 CRE8 ATP</h1>
        <p className="lead">
          session key 的權限在鏈上，登入只是為了讓後端知道「你是這個帳戶的擁有者」。簽名用的是 EIP-4361
          （SIWE），內容包含 domain、chainId 與一次性 nonce。
        </p>
      </div>

      <section className="card stack">
        <div className="spread">
          <h2>錢包</h2>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setDiscovering(true);
              void discoverProviders().then((found) => {
                setProviders(found);
                setDiscovering(false);
              });
            }}
          >
            重新偵測
          </button>
        </div>

        {discovering ? (
          <div className="row">
            <Spinner /> <span className="muted">偵測 EIP-6963 錢包…</span>
          </div>
        ) : providers.length === 0 ? (
          <Note tone="warn">
            沒有偵測到錢包。EIP-6963 需要瀏覽器擴充功能主動廣播；如果錢包已安裝卻沒出現，重新整理這一頁再試。
          </Note>
        ) : (
          <div className="row">
            {providers.map((detail) => (
              <button
                key={detail.info.uuid}
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void connectInjected(detail)}
              >
                {detail.info.name}
                <span className="muted mono" style={{ fontSize: 11 }}>
                  {detail.info.rdns}
                </span>
              </button>
            ))}
          </div>
        )}

        {wallet.address === null ? null : (
          <div className="row">
            <span className="muted">已連線</span>
            <span className="mono" title={wallet.address}>
              {shortAddress(wallet.address)}
            </span>
            <Badge tone={wallet.kind === 'dev' ? 'warn' : 'ok'}>
              {wallet.kind === 'dev' ? 'dev 私鑰' : (wallet.rdns ?? 'injected')}
            </Badge>
          </div>
        )}

        {import.meta.env.DEV ? (
          <details>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
              dev 私鑰連線（只在 dev build 出現）
            </summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <Field label="私鑰" hint={`本機 anvil 的 #3：${DEV_KEY_HINT.slice(0, 10)}…`}>
                <input
                  type="password"
                  value={devKey}
                  placeholder="0x…"
                  onChange={(event) => setDevKey(event.target.value)}
                />
              </Field>
              <div className="row">
                <button type="button" className="btn" disabled={busy !== null} onClick={connectDev}>
                  用私鑰連線
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDevKey(DEV_KEY_HINT)}>
                  填入 anvil #3
                </button>
              </div>
            </div>
          </details>
        ) : null}
      </section>

      <section className="card stack">
        <div>
          <p className="eyebrow">步驟 2 · 簽名</p>
          <h2>SIWE 登入</h2>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canSign || busy !== null}
          onClick={() => {
            if (wallet.kind === 'dev' && wallet.devSigner !== null) {
              void signIn(wallet.devSigner.address, wallet.devSigner.signMessage);
              return;
            }
            if (wallet.provider !== null && wallet.address !== null) {
              void signIn(wallet.address, (message) => signWithProvider(wallet.provider!, wallet.address!, message));
            }
          }}
        >
          {busy ?? (canSign ? '簽名並登入' : '先連線錢包')}
        </button>
        {busy === null ? null : (
          <div className="row">
            <Spinner /> <span className="muted">{busy}</span>
          </div>
        )}
        <ErrorNote error={error} />
      </section>
    </main>
  );
}
