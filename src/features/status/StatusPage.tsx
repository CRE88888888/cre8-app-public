import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPortfolioStatus } from '../../lib/api';
import type { PortfolioStatus, SessionKeyReport } from '../../lib/api';
import { formatBps, formatUsdE8, shortAddress, toneForBps } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useSession } from '../../store/session';
import { Badge, ErrorNote, Note, Spinner } from '../../components/ui';
import { RebalanceCard } from '../rebalance/RebalanceCard';
import { RenewalCard } from '../renewal/RenewalCard';

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
            / threshold {status.drift.thresholdBps} bps / needs rebalance:
          </span>
          <span className={needs ? 'neg' : 'pos'}>{needs ? 'yes' : 'no'}</span>
        </dd>
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
          <strong>When the status cannot be read, this page shows no drift numbers at all.</strong>
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
