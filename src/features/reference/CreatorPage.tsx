import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useBodyClass } from '../../lib/use-body-class';
import { REFERENCE_FUNDS } from '../../lib/public-funds';
import { CRE8_CREATOR, creatorId, rankCreators } from '../../lib/creators';
import { selectFunds } from '../../reference/lib/fund-explore';
import { performancePeriod } from '../../reference/lib/fund-navigation';
import { safePublicReturn } from '../../lib/public-navigation';
import { FundRow } from './FundRow';
export function CreatorPage() {
  useBodyClass('fund-explore', 'atp-formal-market', 'atp-complete-market');
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const period = performancePeriod(params.get('period'));
  const creator = rankCreators(REFERENCE_FUNDS, period).find(entry => entry.id === creatorId(id));
  const backTo = safePublicReturn(params.get('returnTo'), window.location.origin) || '/leaderboard';
  if (!creator) return <main className="page"><h1>Creator not found</h1><Link to="/leaderboard">All creators</Link></main>;
  return (
    <main className="explore-wrap" id="fund-explore">
      <Link className="vault-back" to={backTo}>← Back</Link>
      <header className="explore-heading"><div><h1>{creator.name}<span>.</span></h1><p>{creator.funds.length} reference funds{creator.id === CRE8_CREATOR ? ' across market themes, public figures and X voices.' : '.'}</p></div></header>
      <label className="creator-period">Period<select aria-label="Fund period" value={period} onChange={event => { const next = new URLSearchParams(params); next.set('period', event.target.value); setParams(next, { replace: true }); }}>
        {['7D', '30D', '90D', '1Y', 'ALL'].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <div className="fund-list">{selectFunds(creator.funds, '', 'all', 'perf', period).map(fund => <FundRow key={fund.slug} fund={fund as (typeof REFERENCE_FUNDS)[number]} period={period} returnTo={location.pathname + location.search} />)}</div>
    </main>
  );
}
