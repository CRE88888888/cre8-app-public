import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatEther, parseEther } from 'viem';
import { getPortfolioStatus } from '../../lib/api';
import type { PortfolioStatus, SessionKeyReport } from '../../lib/api';
import { formatBps, formatUsdE8, shortAddress, toneForBps } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useSession } from '../../store/session';
import { useOwnerWallet } from '../../lib/use-owner-wallet';
import { sendGasTopUp } from '../../lib/kernel';
import { Badge, ErrorNote, Note, Spinner } from '../../components/ui';
import { RebalanceCard } from '../rebalance/RebalanceCard';
import { RenewalCard } from '../renewal/RenewalCard';

/**
 * 帳戶的 gas 一列（放在 gross drift 下面）。
 *
 * 為什麼值得單獨一列：**gas 是每個帳戶自己付的**（ERC-4337 的 sender 模型），而一個帳戶 = 一個
 * 「owner + 策略」組合。所以「這檔基金還能不能動」=「它自己還有沒有 BNB」——
 * 這件事跟別的投組無關，而使用者原本只能在一團 op 失敗訊息裡猜到。
 *
 * Top up 用 owner 錢包轉 BNB。**後端做不到這件事**（沒有 owner 私鑰，session key 也不能轉帳），
 * 所以只能由使用者在這裡按一次。
 */
function GasRow({ status, portfolioId }: { status: PortfolioStatus; portfolioId: number }): ReactNode {
  const token = useSession((state) => state.token);
  const wallet = useOwnerWallet();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<string | null>(null);

  const gas = status.gas;
  // 沒 gas 資訊就誠實說不知道，不要顯示 0（那會被讀成「沒錢」）。
  if (gas === null || gas === undefined) {
    return (
      <>
        <dt>gas</dt>
        <dd className="muted">unknown — the RPC could not be read, so this is not the same as “no balance”</dd>
      </>
    );
  }

  const shortfall = BigInt(gas.shortfallWei ?? '0');
  // 已經 ready 時再補「一次 op 的量」的兩倍，讓它有餘裕；不足時補到門檻。
  const suggestedWei = shortfall > 0n ? shortfall : parseEther('0.01');

  const topUp = useCallback(async () => {
    if (wallet === null || token === null) return;
    setBusy(true);
    setError(null);
    try {
      const hash = await sendGasTopUp({ wallet, to: status.account as `0x${string}`, valueWei: suggestedWei });
      setSent(hash);
      await queryClient.invalidateQueries({ queryKey: queryKeys.status(token, portfolioId) });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }, [portfolioId, queryClient, status.account, suggestedWei, token, wallet]);

  return (
    <>
      <dt>gas</dt>
      <dd>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            <strong className={gas.ready === true ? 'pos' : 'neg'}>{Number(formatEther(BigInt(gas.balanceWei ?? '0'))).toFixed(6)} BNB</strong>
            <span className="muted">
              {' '}
              / minimum {Number(formatEther(BigInt(gas.minimumWei ?? '0'))).toFixed(4)} BNB · about{' '}
              {gas.estimatedOps ?? 0} op{gas.estimatedOps === 1 ? '' : 's'} left · paid by this account, not by you
            </span>
            {gas.ready === true ? null : (
              <span className="neg"> · needs {Number(formatEther(shortfall)).toFixed(6)} BNB</span>
            )}
          </span>
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            {wallet === null ? (
              // 停用的按鈕不該只有 hover 才說原因：連錢包是唯一的解法，就寫出來。
              <span className="muted" style={{ fontSize: 12 }}>
                connect the owner wallet to top up
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy || wallet === null}
              onClick={() => void topUp()}
            >
              {busy ? 'Sending…' : `Top up ${Number(formatEther(suggestedWei)).toFixed(4)} BNB`}
            </button>
          </span>
        </div>
        {sent === null ? null : (
          <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
            top-up sent: {sent}
          </div>
        )}
        <ErrorNote error={error} />
      </dd>
    </>
  );
}

function SessionKeyNote({ report }: { report: SessionKeyReport }): ReactNode {
  // `usable === null` 只有在 `error === null` 時才可以讀成「沒有可用的 key」。
  if (report.error !== null) {
    return (
      <Note tone="warn">
        Session key: cannot read install state ({report.error}) — <strong>this does not mean there is no usable key</strong>.
      </Note>
    );
  }
  if (report.configured === null) {
    return <Note tone="bad">This portfolio has no session key recorded in the database.</Note>;
  }
  if (report.configured.installed) {
    return (
      <div className="row">
        <Badge tone="ok">Installed</Badge>
        <span className="mono">{report.configured.permissionId}</span>
        <span className="muted mono">{report.configured.keyRef}</span>
      </div>
    );
  }
  return (
    <Note tone="warn">
      The key the database records <span className="mono">{report.configured.permissionId}</span> is <strong>not installed on-chain</strong>
      {report.usable === null ? (
        <>, and no installed active key exists → rebalancing will be blocked (this is not "waiting for the right moment").</>
      ) : (
        <>
          ; the one actually used is <span className="mono">{report.usable.permissionId}</span>
          <span className="muted mono">（{report.usable.keyRef}）</span>。
        </>
      )}
    </Note>
  );
}

function StatusBody({ status }: { status: PortfolioStatus }): ReactNode {
  const needs = status.drift.needsRebalance;
  return (
    <div className="stack">
      <div className="spread">
        <h2>Portfolio #{status.portfolioId}</h2>
        <div className="row">
          <Badge tone={status.complete ? 'ok' : 'warn'}>{status.complete ? 'Complete' : 'Partial'}</Badge>
          <span className="muted mono">block #{status.block}</span>
        </div>
      </div>

      <dl className="kv">
        <dt>account</dt>
        <dd className="mono" title={status.account}>
          {shortAddress(status.account, 8, 6)}
        </dd>
        <dt>Total value</dt>
        <dd>{formatUsdE8(status.totalUsdE8)}</dd>
        <dt>gross drift</dt>
        <dd>
          <strong>{status.drift.grossDriftBps} bps</strong>
          <span className="muted">
            {' '}
            / threshold {status.drift.thresholdBps} bps / needs rebalance:{' '}
          </span>
          <span className={needs ? 'neg' : 'pos'}>{needs ? 'yes' : 'no'}</span>
        </dd>

        <GasRow status={status} portfolioId={status.portfolioId} />
      </dl>

      {status.complete ? null : (
        <Note tone="warn">
          Some holdings have no price (<code>complete = false</code>), so the drift above is a <strong>partial</strong> result.
        </Note>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>symbol</th>
            <th className="num">Target bps</th>
            <th className="num">Current bps</th>
            <th className="num">Delta</th>
            <th className="num">USD value</th>
          </tr>
        </thead>
        <tbody>
          {status.drift.assets.map((row) => (
            <tr key={row.asset}>
              <td>{row.symbol}</td>
              <td className="num">{row.targetBps}</td>
              <td className="num">{row.currentBps}</td>
              <td className={`num ${toneForBps(row.deltaBps)}`}>{formatBps(row.deltaBps)}</td>
              <td className="num">{formatUsdE8(row.usdValueE8)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {status.blocked.length === 0 ? null : (
        <Note tone="bad">
          <strong>Blocked legs ({status.blocked.length})</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {status.blocked.slice(0, 5).map((entry, index) => (
              <li key={index} className="mono" style={{ fontSize: 12 }}>
                {JSON.stringify(entry).slice(0, 220)}
              </li>
            ))}
          </ul>
        </Note>
      )}

      {status.sessionKey === undefined || status.sessionKey === null ? null : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="muted" style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            session key
          </div>
          <SessionKeyNote report={status.sessionKey} />
        </div>
      )}
    </div>
  );
}

export function StatusPage(): ReactNode {
  const token = useSession((state) => state.token);
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const valid = Number.isInteger(id) && id > 0;

  const query = useQuery({
    queryKey: queryKeys.status(token, valid ? id : -1),
    queryFn: () => getPortfolioStatus(token as string, id),
    enabled: token !== null && valid,
  });

  return (
    <main className="page stack">
      <div className="spread">
        <Link className="btn btn--ghost btn--sm" to="/">
          ← Back to funds
        </Link>
        <button
          type="button"
          className="btn btn--sm"
          disabled={query.isFetching || !valid}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Reloading…' : 'Reload status'}
        </button>
      </div>

      {!valid ? <Note tone="bad">portfolio id is not a positive integer: {params.id ?? '(empty)'}</Note> : null}

      {query.isPending && valid ? (
        <div className="card stack">
          <div className="row">
            <Spinner /> <span>Loading…</span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            The backend scans Transfer logs, reads pools and prices them — 2–3 seconds in practice, not a hang.
          </p>
        </div>
      ) : null}

      <ErrorNote error={query.error} />

      {query.error !== null && query.error !== undefined ? (
        <Note>
          <strong>When the status cannot be read, this page shows no drift numbers at all.</strong>{' '}
          Deliberate: a plausible-looking "0 drift, no rebalance needed" is far more dangerous than an error message.
        </Note>
      ) : null}

      {query.data === undefined ? null : (
        <div className="card">
          <StatusBody status={query.data} />
        </div>
      )}

      {/* 順序刻意：先「現在執行」再「換 key」。使用者多是為了讓投組回到目標而來。 */}
      {query.data === undefined ? null : <RebalanceCard status={query.data} />}

      {valid ? <RenewalCard portfolioId={id} /> : null}
    </main>
  );
}
