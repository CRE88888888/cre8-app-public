import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPortfolioStatus } from '../../lib/api';
import type { PortfolioStatus, SessionKeyReport } from '../../lib/api';
import { formatBps, formatUsdE8, shortAddress, toneForBps } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useSession } from '../../store/session';
import { Badge, ErrorNote, Note, Spinner } from '../../components/ui';

function SessionKeyNote({ report }: { report: SessionKeyReport }): ReactNode {
  // `usable === null` 只有在 `error === null` 時才可以讀成「沒有可用的 key」。
  if (report.error !== null) {
    return (
      <Note tone="warn">
        session key：讀不到安裝狀態（{report.error}）—— <strong>這不等於「沒有可用的 key」</strong>。
      </Note>
    );
  }
  if (report.configured === null) {
    return <Note tone="bad">這個投組在 DB 裡沒有任何 session key 紀錄。</Note>;
  }
  if (report.configured.installed) {
    return (
      <div className="row">
        <Badge tone="ok">已安裝</Badge>
        <span className="mono">{report.configured.permissionId}</span>
        <span className="muted mono">{report.configured.keyRef}</span>
      </div>
    );
  }
  return (
    <Note tone="warn">
      DB 記的 key <span className="mono">{report.configured.permissionId}</span> <strong>鏈上沒有安裝</strong>
      {report.usable === null ? (
        <>，而且沒有任何已安裝的 active key → 再平衡會被擋（不是「剛好在等時機」）。</>
      ) : (
        <>
          ；實際會用的是 <span className="mono">{report.usable.permissionId}</span>
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
        <h2>投組狀態 · #{status.portfolioId}</h2>
        <div className="row">
          <Badge tone={status.complete ? 'ok' : 'warn'}>{status.complete ? '完整' : '部分'}</Badge>
          <span className="muted mono">block #{status.block}</span>
        </div>
      </div>

      <dl className="kv">
        <dt>account</dt>
        <dd className="mono" title={status.account}>
          {shortAddress(status.account, 8, 6)}
        </dd>
        <dt>總價值</dt>
        <dd>{formatUsdE8(status.totalUsdE8)}</dd>
        <dt>gross drift</dt>
        <dd>
          <strong>{status.drift.grossDriftBps} bps</strong>
          <span className="muted">
            {' '}
            / 門檻 {status.drift.thresholdBps} bps / 需要再平衡：
          </span>
          <span className={needs ? 'neg' : 'pos'}>{needs ? '是' : '否'}</span>
        </dd>
      </dl>

      {status.complete ? null : (
        <Note tone="warn">
          有持倉沒有價格（<code>complete = false</code>），所以上面的漂移是<strong>部分結果</strong>，不是全部。
        </Note>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>symbol</th>
            <th className="num">目標 bps</th>
            <th className="num">現況 bps</th>
            <th className="num">差額</th>
            <th className="num">USD 價值</th>
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
          <strong>被擋下的部位（{status.blocked.length}）</strong>
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
          ← 回列表
        </Link>
        <button
          type="button"
          className="btn btn--sm"
          disabled={query.isFetching || !valid}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? '重新載入…' : '重新載入狀態'}
        </button>
      </div>

      {!valid ? <Note tone="bad">portfolio id 不是正整數：{params.id ?? '(空)'}</Note> : null}

      {query.isPending && valid ? (
        <div className="card stack">
          <div className="row">
            <Spinner /> <span>讀取中…</span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            後端要掃 Transfer 日誌、讀池子、定價 —— 實測 2–3 秒，不是卡住。
          </p>
        </div>
      ) : null}

      <ErrorNote error={query.error} />

      {query.error !== null && query.error !== undefined ? (
        <Note>
          <strong>讀不到狀態時，這一頁不會顯示任何漂移數字。</strong>
          刻意的：一個看起來正常的「漂移 0、不需要再平衡」比一個錯誤訊息危險得多。
        </Note>
      ) : null}

      {query.data === undefined ? null : (
        <div className="card">
          <StatusBody status={query.data} />
        </div>
      )}
    </main>
  );
}
