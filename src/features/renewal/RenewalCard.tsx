import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { Address, Hex } from 'viem';
import { getRenewalParams, postRenewalResult } from '../../lib/api';
import type { RenewalParams } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { sendRenewalUserOp } from '../../lib/kernel';
import type { RenewalReceipt, RenewalWallet } from '../../lib/kernel';
import { queryKeys } from '../../lib/query';
import { useSession } from '../../store/session';
import { useWallet } from '../../store/wallet';
import { ErrorNote, Note } from '../../components/ui';
import { WalletConnect } from '../../components/WalletConnect';

type Phase = 'idle' | 'params' | 'sending' | 'recording' | 'done';

/**
 * 續期：在鏈上安裝一組新的 session key 權限。
 *
 * 這一筆是 **owner（sudo）簽名**的 UserOp，所以錢包必須是帳戶的 owner。
 * 流程刻意分成「先看要簽什麼 → 勾選確認 → 才送出」，因為它花 gas 而且會改變鏈上權限。
 */
export function RenewalCard({ portfolioId }: { portfolioId: number }): ReactNode {
  const token = useSession((state) => state.token);
  const sessionAddress = useSession((state) => state.address);
  const wallet = useWallet();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>('idle');
  const [params, setParams] = useState<RenewalParams | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<RenewalReceipt | null>(null);
  const [recorded, setRecorded] = useState<{ keyRef: string; permissionId: string; duplicate: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const renewalWallet: RenewalWallet | null =
    wallet.kind === 'injected' && wallet.provider !== null && wallet.address !== null
      ? { kind: 'injected', address: wallet.address as Address, provider: wallet.provider }
      : wallet.kind === 'dev' && wallet.devSigner !== null
        ? { kind: 'dev', address: wallet.devSigner.address as Address, account: wallet.devSigner.account }
        : null;

  const ownerMatches =
    renewalWallet !== null &&
    sessionAddress !== null &&
    renewalWallet.address.toLowerCase() === sessionAddress.toLowerCase();

  const loadParams = useCallback(async () => {
    if (token === null) return;
    setError(null);
    setReceipt(null);
    setRecorded(null);
    setConfirmed(false);
    setPhase('params');
    try {
      setParams(await getRenewalParams(token, portfolioId));
    } catch (cause) {
      setError(cause);
      setPhase('idle');
    }
  }, [portfolioId, token]);

  const execute = useCallback(async () => {
    if (token === null || params === null || renewalWallet === null) return;
    setError(null);
    try {
      setPhase('sending');
      const sent = await sendRenewalUserOp({
        wallet: renewalWallet,
        token,
        accountAddress: params.accountAddress as Address,
        entryPoint: params.entryPoint,
        initConfig: params.initConfig as Hex[],
      });
      setReceipt(sent);
      if (!sent.success) {
        // 上鏈但 op 失敗：EntryPoint 會吞掉執行錯誤，tx.status 仍是 1，所以不能只看 txHash。
        throw new Error(
          `UserOp 上鏈但執行失敗（tx ${sent.txHash}）—— 權限沒有安裝成功，鏈上狀態沒變。gas 已經花掉。`,
        );
      }
      setPhase('recording');
      const result = await postRenewalResult(token, portfolioId, {
        keyRef: params.keyRef,
        permissionId: params.permissionId,
        validUntil: params.validUntil,
        policySnapshot: params.policySnapshot,
      });
      setRecorded({ ...result.recorded, duplicate: result.duplicate === true });
      setPhase('done');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.status(token, portfolioId) }),
      ]);
    } catch (cause) {
      setError(cause);
      setPhase('params');
    }
  }, [params, portfolioId, queryClient, renewalWallet, token]);

  const busy = phase === 'sending' || phase === 'recording';

  return (
    <section className="card stack">
      <div>
        <p className="eyebrow">續期</p>
        <h2>換一把新的 session key</h2>
        <p className="lead" style={{ fontSize: 13 }}>
          後端用 master seed 派生新金鑰，這一頁負責**用 owner 錢包在鏈上安裝**它，再把結果記回 DB。
          這是一筆真的鏈上交易（會花 gas）。
        </p>
      </div>

      {renewalWallet === null ? (
        // 重新整理後 session 還在、錢包卻掉了（provider 不能序列化）。這裡直接給重連入口 ——
        // 只寫一句「先連線錢包」等於把使用者困住：他已經登入了，沒有別的地方可以連。
        <>
          <Note tone="warn">
            錢包連線不跨重新整理（provider 不是可序列化的資料），所以要在這裡重連一次才能簽名。
            你的登入狀態還在，不用重新登入。
          </Note>
          <WalletConnect />
        </>
      ) : ownerMatches ? null : (
        <Note tone="bad">
          目前連線的錢包 <span className="mono">{renewalWallet.address}</span> 不是這個帳戶的 owner
          <span className="mono">（{sessionAddress ?? '未知'}）</span>。續期會失敗，請切換錢包。
        </Note>
      )}

      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={busy || token === null || phase === 'params'}
          onClick={() => void loadParams()}
        >
          {phase === 'params' ? '取得參數…' : params === null ? '準備續期參數' : '重新取得參數'}
        </button>
      </div>

      <ErrorNote error={error} />

      {params === null ? null : (
        <div className="stack">
          <dl className="kv">
            <dt>新 key</dt>
            <dd className="mono" title={params.sessionKeyAddress}>
              {params.sessionKeyAddress}
            </dd>
            <dt>keyRef</dt>
            <dd className="mono">{params.keyRef}</dd>
            <dt>permissionId</dt>
            <dd className="mono">{params.permissionId}</dd>
            <dt>有效到</dt>
            <dd>
              {formatDateTime(params.expiresAt)}
              <span className="muted mono"> (unix {params.validUntil})</span>
            </dd>
            <dt>install 筆數</dt>
            <dd>{params.initConfig.length}（打給帳戶自己，`msg.sender == self`）</dd>
            <dt>executor</dt>
            <dd className="mono" title={params.executorAddress}>
              {params.executorAddress}
            </dd>
          </dl>

          <Note tone="warn">
            這會在鏈上安裝一組新權限，舊的不會被撤銷（它仍然有效到自己的到期日）。送出後 gas 由這個帳戶支付。
          </Note>

          <label className="row" style={{ gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我知道這是一筆真的鏈上交易，會花 gas
          </label>

          <div className="row">
            <button
              type="button"
              className="btn btn--primary"
              style={{ maxWidth: 260 }}
              disabled={!confirmed || busy || !ownerMatches || receipt !== null}
              onClick={() => void execute()}
            >
              {phase === 'sending' ? '在錢包簽名並送出…' : phase === 'recording' ? '記回後端…' : '確認並送出'}
            </button>
            {receipt === null ? null : (
              <span className="muted" style={{ fontSize: 12 }}>
                gasUsed {receipt.gasUsed ?? '?'}
              </span>
            )}
          </div>
        </div>
      )}

      {receipt === null ? null : (
        <Note tone={receipt.success ? 'neutral' : 'bad'}>
          <strong>{receipt.success ? '已上鏈' : '上鏈但執行失敗'}</strong>
          <div className="mono" style={{ marginTop: 6, fontSize: 12, wordBreak: 'break-all' }}>
            tx {receipt.txHash}
          </div>
          <div className="mono" style={{ marginTop: 4, fontSize: 12, wordBreak: 'break-all' }}>
            userOp {receipt.userOpHash}
          </div>
        </Note>
      )}

      {recorded === null ? null : (
        <Note>
          <strong>{recorded.duplicate ? '這把 key 之前就記過了' : '已記回 DB'}</strong>
          <div className="mono" style={{ marginTop: 6, fontSize: 12 }}>
            {recorded.keyRef} · {recorded.permissionId}
          </div>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            排程器現在會用這把（DB 由新到舊逐把驗鏈上是否安裝）。
          </div>
        </Note>
      )}
    </section>
  );
}
