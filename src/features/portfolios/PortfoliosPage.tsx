import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getPortfolios } from '../../lib/api';
import { formatDateTime, shortAddress } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useSession } from '../../store/session';
import { Badge, ErrorNote, Note, Spinner } from '../../components/ui';

export function PortfoliosPage(): ReactNode {
  const token = useSession((state) => state.token);

  const query = useQuery({
    queryKey: queryKeys.portfolios(token),
    queryFn: () => getPortfolios(token as string),
    enabled: token !== null,
  });

  return (
    <main className="page stack">
      <div className="spread">
        <div>
          <p className="eyebrow">Portfolios</p>
          <h1>Your portfolios</h1>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Reloading…' : 'Reload'}
        </button>
      </div>

      <ErrorNote error={query.error} />

      {query.isPending ? (
        <div className="row">
          <Spinner /> <span className="muted">Loading…</span>
        </div>
      ) : query.data === undefined ? null : query.data.length === 0 ? (
        <div className="card empty">This account has no portfolios yet</div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>id</th>
                <th>Strategy</th>
                <th>smart account</th>
                <th>gas</th>
                <th>Session key expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.data.map((portfolio) => {
                const account = portfolio.smartAccounts[0];
                const key = portfolio.sessionKey;
                return (
                  <tr key={portfolio.id}>
                    <td className="num">{portfolio.id}</td>
                    <td>
                      {portfolio.strategyId} / v{portfolio.version}
                    </td>
                    <td className="mono" title={account?.address}>
                      {account === undefined ? '—' : shortAddress(account.address)}
                      {account === undefined ? null : (
                        <>
                          {' '}
                          <span className="muted">(chain {account.chainId})</span>
                        </>
                      )}
                    </td>
                    <td>
                      {portfolio.gas?.ready === true ? (
                        <Badge tone="ok">ready</Badge>
                      ) : (
                        <Badge tone="warn">Low</Badge>
                      )}
                    </td>
                    <td className="mono">
                      {key === null ? <span className="muted">No key</span> : formatDateTime(key.expiresAt)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Link className="btn btn--sm" to={`/portfolios/${portfolio.id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Note>
        Opening a fund scans Transfer logs, reads pools and prices them — <strong>2–3 seconds in practice</strong>, not a
        hang.
      </Note>
    </main>
  );
}
