import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useBodyClass } from '../../lib/use-body-class';
import { LISTED_FUNDS } from '../../lib/public-funds';
import { creatorId, rankCreators } from '../../lib/creators';
import { periodMetrics, selectFunds } from '../../reference/lib/fund-explore';
import { performancePeriod } from '../../reference/lib/fund-navigation';
import { safePublicReturn } from '../../lib/public-navigation';
import { BoardRow, longestHistory } from '../vaults/FundBoard';
import type { ReferenceFund } from '../../lib/public-funds';
import { CreatorControls, creatorFilters, matchesReturn } from './CreatorControls';
export function CreatorPage() {
  useBodyClass('fund-explore', 'atp-formal-market', 'atp-complete-market');
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const period = performancePeriod(params.get('period'));
  const creator = rankCreators(LISTED_FUNDS, period).find(entry => entry.id === creatorId(id));
  const backTo = safePublicReturn(params.get('returnTo') ?? '/leaderboard', window.location.origin);
  if (!creator) return <main className="page"><h1>Creator not found</h1><Link to="/leaderboard">All creators</Link></main>;
  const filters = creatorFilters(params);
  const funds = selectFunds(creator.funds, '', 'all', filters.order === 'drawdown' ? 'dd' : 'perf', period,
    filters.asset ? [filters.asset] : [],
  ).filter((fund) => matchesReturn(periodMetrics(fund, period).returnPct, filters.direction));
  if (filters.order === 'name') funds.sort((a, b) => a.name.localeCompare(b.name));
  const fullDays = longestHistory(LISTED_FUNDS, period);
  return (
    <main className="explore-wrap" id="fund-explore">
      <Link className="vault-back" to={backTo}>← Back</Link>
      <header className="explore-heading"><h1>{creator.name}</h1></header>
      <CreatorControls params={params} setParams={setParams} isLeaderboard={false} />
      {/* 跟 Funds 頁同一張榜（原本這裡還是大封面卡片格）。 */}
      {funds.length > 0 && (
        <section className="mkt-section" aria-label={`${creator.name} funds`}>
          <div className="mkt-board-head" aria-hidden="true">
            <span>#</span>
            <span>Fund</span>
            <span>Holdings</span>
            <span>Trend</span>
            <span>Model return</span>
            <span>Max drawdown</span>
          </div>
          <ol className="mkt-board" role="list">
            {funds.map((fund, index) => (
              <BoardRow
                key={fund.slug}
                fund={fund as ReferenceFund}
                period={period}
                rank={index + 1}
                fullDays={fullDays}
                url={`/funds/${fund.slug}?period=${period}&returnTo=${encodeURIComponent(location.pathname + location.search)}`}
              />
            ))}
          </ol>
        </section>
      )}
      {funds.length === 0 && <div className="directory-empty"><strong>No matching funds</strong></div>}
    </main>
  );
}
