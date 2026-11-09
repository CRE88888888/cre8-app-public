import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getOperatorOverview } from '../../lib/api';
import type { OperatorOverview, OperatorRow } from '../../lib/api';
import { formatEther } from 'viem';
import { formatUsdE8, shortAddress } from '../../lib/format';
import { useBodyClass } from '../../lib/use-body-class';
import { useSession } from '../../store/session';
import { Badge, ErrorNote, Spinner } from '../../components/ui';
import { SignInButton } from '../../components/WalletMenu';

/** 相對時間（「12 秒前」）比絕對時間更能回答「現在有沒有在跑」。 */
function ago(iso: string | null): string {
  if (iso === null) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** 排程時間的方向很重要：`in 5m`（還沒到）與 `due 3h ago`（該跑而沒跑）是兩件不同的事。 */
function due(iso: string | null): string {
  if (iso === null) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const unit = abs < 60_000 ? `${Math.round(abs / 1000)}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : `${Math.round(abs / 3_600_000)}h`;
  return delta >= 0 ? `in ${unit}` : `due ${unit} ago`;
}

function until(iso: string | null): { text: string; tone: string } {
  if (iso === null) return { text: '—', tone: 'muted' };
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { text: '—', tone: 'muted' };
  const days = Math.floor((ms - Date.now()) / 86_400_000);
  if (days < 0) return { text: `expired ${Math.abs(days)}d`, tone: 'neg' };
  if (days < 7) return { text: `${days}d`, tone: 'neg' };
  if (days < 30) return { text: `${days}d`, tone: 'warn' };
  return { text: `${days}d`, tone: 'pos' };
}

/** 一列的「該不該有人去看」訊號：gas 沒了、key 快過期、連續失敗、需要再平衡但沒動。 */
function rowFlags(row: OperatorRow): { label: string; tone: 'ok' | 'warn' | 'bad' }[] {
  const flags: { label: string; tone: 'ok' | 'warn' | 'bad' }[] = [];
  const gas = row.gasWei === null ? null : BigInt(row.gasWei);
  if (row.gasWei === null) flags.push({ label: 'gas unknown', tone: 'warn' });
  else if (gas !== null && gas < 10n ** 16n) flags.push({ label: 'gas low', tone: 'bad' });

  const key = until(row.sessionKeyExpiresAt);
  if (key.tone === 'neg') flags.push({ label: 'key expiring', tone: 'bad' });
  else if (key.tone === 'warn') flags.push({ label: 'key soon', tone: 'warn' });

  if (row.lastOperation?.state === 'failed') flags.push({ label: 'last round failed', tone: 'bad' });
  if (row.needsRebalance === true) flags.push({ label: 'rebalance due', tone: 'warn' });
  if (row.observedAt === null) flags.push({ label: 'never ran', tone: 'warn' });
  return flags;
}

function Dashboard({ overview }: { overview: OperatorOverview }): ReactNode {
  // 預設只顯示 active：這個環境裡有大量測試殘骸（paused / 從沒跑過），全部列出來會蓋掉真正要看的。
  const [showAll, setShowAll] = useState(false);
  const rows = (showAll ? overview.portfolios : overview.portfolios.filter((row) => row.scheduleState === 'active'))
    // 需要有人看的排前面：flags 多的先、其次 id。
    .slice()
    .sort((a, b) => rowFlags(b).length - rowFlags(a).length || a.id - b.id);

  return (
    <>
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>System</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            snapshot at {new Date(overview.generatedAt).toLocaleTimeString('en-GB', { hour12: false })}
          </span>
        </div>
        <dl className="kv">
          <dt>scheduler heartbeat</dt>
          <dd>
            <strong>{ago(overview.lastCheckedAt)}</strong>
            <span className="muted"> / last time any portfolio was checked — if this is stale, the loop is not running</span>
          </dd>
          <dt>alerts</dt>
          <dd>
            {overview.alerts === null ? (
              <span className="neg">unknown (could not read)</span>
            ) : (
              <>
                <span className={overview.alerts.critical > 0 ? 'neg' : 'pos'}>{overview.alerts.critical} critical</span>
                <span className="muted"> · </span>
                <span className={overview.alerts.warn > 0 ? 'warn' : 'pos'}>{overview.alerts.warn} warn</span>
                <span className="muted"> · {overview.alerts.open} open</span>
              </>
            )}
          </dd>
          <dt>portfolios</dt>
          <dd>
            {overview.portfolios.filter((row) => row.scheduleState === 'active').length} active
            <span className="muted"> · {overview.portfolios.length} total (most are leftover test rows)</span>
          </dd>
        </dl>
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Portfolios ({rows.length} shown)
          </span>
          <label className="row" style={{ gap: 6, fontSize: 12, alignItems: 'center' }}>
            <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
            include paused / idle
          </label>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Fund</th>
              <th className="num">Value</th>
              <th className="num">Drift</th>
              <th>Observed</th>
              <th className="num">Gas</th>
              <th className="num">Key</th>
              <th>Next run</th>
              <th>Last round</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = until(row.sessionKeyExpiresAt);
              const flags = rowFlags(row);
              return (
                <tr key={row.id}>
                  <td className="mono">
                    <Link to={`/portfolios/${row.id}`}>{row.id}</Link>
                  </td>
                  <td>
                    {row.strategyName ?? `strategy ${row.strategyId}`}
                    <span className="muted" style={{ fontSize: 11 }}>
                      {' '}
                      v{row.version} · {row.scheduleState}
                    </span>
                    {row.account === null ? null : (
                      <div className="mono muted" style={{ fontSize: 11 }}>
                        {shortAddress(row.account)}
                      </div>
                    )}
                  </td>
                  <td className="num">{row.totalUsdE8 === null ? '—' : formatUsdE8(row.totalUsdE8)}</td>
                  <td className={`num ${row.needsRebalance === true ? 'neg' : ''}`}>
                    {row.driftBps === null ? '—' : `${row.driftBps} bps`}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {ago(row.observedAt)}
                  </td>
                  <td className="num mono" style={{ fontSize: 12 }}>
                    {row.gasWei === null ? '?' : `${Number(formatEther(BigInt(row.gasWei))).toFixed(4)}`}
                  </td>
                  <td className={`num ${key.tone}`} style={{ fontSize: 12 }}>
                    {key.text}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {due(row.nextRunAt)}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {row.lastOperation === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        <Badge
                          tone={
                            row.lastOperation.state === 'confirmed'
                              ? 'ok'
                              : row.lastOperation.state === 'failed'
                                ? 'bad'
                                : 'warn'
                          }
                        >
                          {row.lastOperation.state}
                        </Badge>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {ago(row.lastOperation.createdAt)}
                        </div>
                      </>
                    )}
                  </td>
                  <td>
                    {flags.length === 0 ? (
                      <span className="muted" style={{ fontSize: 12 }}>
                        ok
                      </span>
                    ) : (
                      flags.map((flag) => (
                        <Badge key={flag.label} tone={flag.tone}>
                          {flag.label}
                        </Badge>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Rebalance dashboard（operator 視角）。
 *
 * 刻意與 portfolio 頁不同：那一頁回答「我的基金怎麼樣」，這一頁回答
 * **「有哪一檔需要有人去看」** —— 所以每一列都帶 flags，而且 System 區塊第一眼就放
 * `scheduler heartbeat`（沉默與沒在跑在畫面上長得一樣，這是我們踩過的坑）。
 *
 * 資料來自 `/operator/overview`：讀已落地的快照與 operation，只有 gas 是即時讀。
 * 代價是「Observed」可能是幾分鐘前 —— 所以那一欄直接顯示相對時間，新鮮度自己看得到。
 */
export function OperatorPage(): ReactNode {
  useBodyClass('portfolio-page', 'fund-explore');
  const token = useSession((state) => state.token);

  const overview = useQuery({
    queryKey: ['operator-overview', token],
    queryFn: () => getOperatorOverview(token as string),
    enabled: token !== null,
    refetchInterval: 15_000,
  });

  return (
    <main className="explore-wrap">
      <header className="explore-heading">
        <div>
          <h1>
            Rebalance<span>.</span>
          </h1>
          <p>
            Operator view: every portfolio, how stale its last observation is, whether it can pay for gas, and which
            ones need attention. Auto-refreshes every 15 seconds.
          </p>
        </div>
        <div className="explore-heading-actions">
          <button type="button" className="btn" disabled={overview.isFetching} onClick={() => void overview.refetch()}>
            {overview.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {token === null ? (
        <div className="directory-empty">
          <strong>Sign in to see the operator view</strong>
          <p>
            <SignInButton /> opens the wallet menu in the header.
          </p>
        </div>
      ) : overview.isPending ? (
        <div className="card row">
          <Spinner /> <span className="muted">Loading overview…</span>
        </div>
      ) : overview.error !== null && overview.error !== undefined ? (
        <ErrorNote error={overview.error} />
      ) : overview.data === undefined ? null : (
        <Dashboard overview={overview.data} />
      )}
    </main>
  );
}
