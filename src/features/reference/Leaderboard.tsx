import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useBodyClass } from '../../lib/use-body-class';
import { REFERENCE_FUNDS, pct } from '../../lib/public-funds';
import { CRE8_CREATOR, creatorPath, rankCreators } from '../../lib/creators';
import { performancePeriod } from '../../reference/lib/fund-navigation';
import type { Period } from '../../reference/lib/fund-explore';

const PERIODS: Period[] = ['7D', '30D', '90D', '1Y', 'ALL'];
export function Leaderboard() {
  useBodyClass('fund-explore', 'atp-formal-market', 'atp-complete-market', 'atp-creators');
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const period = performancePeriod(params.get('period'));
  const query = params.get('q') ?? '';
  const creators = rankCreators(REFERENCE_FUNDS, period).map((creator, index) => ({ ...creator, rank: index + 1 })).filter(creator =>
    `${creator.name} ${creator.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };
  return (
    <main className="explore-wrap" id="creator-leaderboard">
      <header className="explore-heading"><h1>Leaderboard<span>.</span></h1></header>
      <p className="creator-lead">Creators and the funds they build.</p>
      <p className="creator-disclosure">Reference catalogue · Model returns · Before fees</p>
      <div className="creator-toolbar">
        <div className="seg public-periods" role="group" aria-label="Ranking period">
          {PERIODS.map(value => <button key={value} type="button" className={value === period ? 'on' : ''} aria-pressed={value === period} onClick={() => update('period', value)}>{value === 'ALL' ? 'All' : value}</button>)}
        </div>
        <label className="creator-search"><span>Find a creator</span><input type="search" aria-label="Find a creator" placeholder="Name or address" value={query} onChange={event => update('q', event.target.value)} /></label>
      </div>
      {creators.length ? (
        <table className="creator-table">
          <caption className="sr-only">Creators ranked by average model return</caption>
          <thead><tr><th scope="col">Rank</th><th scope="col">Creator</th><th scope="col">Funds</th><th scope="col">Avg. model return</th></tr></thead>
          <tbody>{creators.map(creator => <tr key={creator.id} data-creator={creator.id}>
            <td className="creator-rank">{creator.rank}</td>
            <td><Link className="creator-identity" to={`${creatorPath(creator.id)}?period=${period}&returnTo=${encodeURIComponent(location.pathname + location.search)}`}>
              {creator.id === CRE8_CREATOR ? <img src="/logos/cre8-icon.svg" alt="" width="40" height="40" /> : null}
              <span><strong>{creator.name}</strong><small>{creator.id.slice(0, 6)}…{creator.id.slice(-4)}</small></span>
            </Link></td>
            <td className="creator-count">{creator.funds.length}</td>
            <td className="creator-return"><strong className={creator.averageReturn === null ? '' : creator.averageReturn >= 0 ? 'pos' : 'neg'}>{pct(creator.averageReturn)}</strong><small>{creator.measuredFunds} {creator.measuredFunds === 1 ? 'model' : 'models'}{creator.partial ? ' · shorter histories included' : ''}</small></td>
          </tr>)}</tbody>
        </table>
      ) : <div className="directory-empty"><strong>No matching creators</strong><p>Try a different name or address.</p><button className="btn ghost sm" type="button" onClick={() => update('q', '')}>Clear search</button></div>}
      <details className="creator-method"><summary>How rankings work</summary><p>One row per creator address. The return is the equal-weight average of available fund model returns for the selected period, before fees. A 1Y history shorter than a year uses the model’s since-inception return. Missing returns are excluded.</p><p>These are reference models, not holder profits or live assets under management. Public figures and X voices are model subjects; they are not treated as creators.</p></details>
    </main>
  );
}
