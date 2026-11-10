import type { ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useBodyClass } from '../../lib/use-body-class';
import { MOCK_FUNDS } from '../../data/mock-funds';
import type { MockFund } from '../../data/mock-funds';
import { MOCK_PERFORMANCE } from '../../data/mock-performance';
import { fundCover } from '../../data/fund-covers';
import { AssetLogo } from '../../components/AssetLogo';

const ORDER = ['ai-buildout', 'mag7', 'treasury-reserve', 'multi-asset-balanced', 'crypto-leaders'];
const CRYPTO = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK']);
const RWA = new Set(['SGOV', 'IEF', 'TLT', 'XAU']);

function assetClasses(fund: MockFund): string[] {
  return [...new Set(fund.holdings.filter(row => row.symbol !== 'USDT').map(row =>
    CRYPTO.has(row.symbol) ? 'crypto' : RWA.has(row.symbol) ? 'rwa' : 'stocks',
  ))];
}

/** 目錄只換呈現；績效沿用有模擬標示的既有資料，策略配對留在基金頁。 */
function FundRow({ fund, returnTo }: { fund: MockFund; returnTo: string }): ReactNode {
  const cover = fundCover(fund.slug);
  const performance = MOCK_PERFORMANCE[fund.slug];
  const preview = fund.holdings.slice(0, 3);
  return (
    <article className="fund-row">
      <Link className="fund-row-link" to={`/funds/${fund.slug}?returnTo=${encodeURIComponent(returnTo)}`}>
        <span className="fund-thumb" data-fund-cover>
          {cover === undefined ? fund.mark : <img src={cover.thumbnail} alt="" loading="lazy" width="192" height="192" />}
        </span>
        <div className="fund-list-body">
          <h3>{fund.name}</h3>
          <span className="fund-row-creator"><img src="/logos/cre8-icon.svg" alt="" width="17" height="17" />CRE8</span>
        </div>
        <span className="fund-list-result">
          <strong className={performance === undefined ? '' : performance.returnBps >= 0 ? 'pos' : 'neg'}>
            {performance === undefined ? '—' : `${performance.returnBps >= 0 ? '+' : '−'}${(Math.abs(performance.returnBps) / 100).toFixed(2)}%`}
          </strong>
        </span>
        <span className="fund-asset-icons" aria-label={`Assets: ${fund.holdings.map(row => row.symbol).join(', ')}`}>
          {preview.map(row => <AssetLogo key={row.symbol} symbol={row.symbol} />)}
          {fund.holdings.length > preview.length ? <span className="fund-assets-more">+{fund.holdings.length - preview.length}</span> : null}
        </span>
      </Link>
    </article>
  );
}

export function VaultsPage(): ReactNode {
  useBodyClass('vault-directory', 'fund-explore', 'atp-formal-market');
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const query = search.get('q') ?? '';
  const category = ['themes', 'people'].includes(search.get('category') ?? '') ? search.get('category') : 'all';
  const asset = ['stocks', 'crypto', 'rwa'].includes(search.get('asset') ?? '') ? search.get('asset') : 'all';
  const requestedSort = search.get('sort') ?? 'default';
  const sort = ['name', 'return'].includes(requestedSort) ? requestedSort : 'default';
  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(search);
    if (value === '' || value === 'all' || value === 'default') next.delete(key);
    else next.set(key, value);
    setSearch(next, { replace: true });
  };
  const visible = MOCK_FUNDS.filter(fund => {
    const group = fund.portrait === undefined ? 'themes' : 'people';
    const text = [fund.name, fund.symbol, fund.thesis, ...fund.holdings.map(row => row.symbol)].join(' ').toLowerCase();
    return (category === 'all' || category === group) && (asset === 'all' || assetClasses(fund).includes(asset ?? '')) &&
      query.trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
  }).sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'return') return (MOCK_PERFORMANCE[b.slug]?.returnBps ?? -Infinity) - (MOCK_PERFORMANCE[a.slug]?.returnBps ?? -Infinity);
    const index = (slug: string): number => ORDER.includes(slug) ? ORDER.indexOf(slug) : ORDER.length;
    return index(a.slug) - index(b.slug);
  });
  const returnTo = location.pathname + location.search;

  return (
    <main className="explore-wrap" id="fund-explore">
      <header className="explore-heading"><h1>Explore funds<span>.</span></h1></header>
      <p className="explore-disclosure">Example funds · Simulated performance · Before fees</p>
      <div className="explore-toolbar">
        <div className="explore-filter-list" aria-label="Fund filters">
          <details className="explore-filter">
            <summary>Category{category === 'all' ? '' : ` · ${category === 'themes' ? 'Market themes' : 'People'}`}</summary>
            <div className="explore-filter-panel" role="radiogroup" aria-label="Fund category">
              {[['all', 'All funds'], ['themes', 'Market themes'], ['people', 'People']].map(([value, label]) => (
                <label className="explore-filter-option" key={value}><input type="radio" name="fund-category" value={value} checked={category === value} onChange={() => update('category', value ?? 'all')} /><span>{label}</span></label>
              ))}
            </div>
          </details>
          <details className="explore-filter">
            <summary>Assets{asset === 'all' ? '' : ` · ${asset === 'rwa' ? 'RWA' : asset === 'stocks' ? 'Stocks' : 'Crypto'}`}</summary>
            <div className="explore-filter-panel" role="radiogroup" aria-label="Asset class">
              {[['all', 'All assets'], ['stocks', 'Stocks'], ['crypto', 'Crypto'], ['rwa', 'RWA']].map(([value, label]) => (
                <label className="explore-filter-option" key={value}><input type="radio" name="fund-assets" value={value} checked={asset === value} onChange={() => update('asset', value ?? 'all')} /><span>{label}</span></label>
              ))}
            </div>
          </details>
          <details className="explore-filter">
            <summary>Advanced</summary>
            <div className="explore-filter-panel atp-sort-filter">
              <label>Sort funds<select aria-label="Sort funds" value={sort} onChange={event => update('sort', event.target.value)}><option value="default">Default order</option><option value="return">Highest return</option><option value="name">Fund name</option></select></label>
              <p>Returns show the existing since-inception simulation.</p>
            </div>
          </details>
        </div>
        <label className="explore-search"><input type="search" placeholder="Filter funds" aria-label="Filter funds" value={query} onChange={event => update('q', event.target.value)} /></label>
      </div>
      {visible.length === 0 ? <div className="directory-empty"><strong>No matches</strong><p>No fund matches these filters.</p></div> : null}
      {([
        ['themes', 'Market themes', 'Explore ideas across stocks, crypto and real-world assets.'],
        ['people', 'People', 'Explore a public figure’s universe or a disclosed equity portfolio.'],
      ] as const).map(([group, title, description]) => {
        const funds = visible.filter(fund => (fund.portrait === undefined ? 'themes' : 'people') === group);
        return funds.length === 0 ? null : (
          <section className="explore-collection" aria-label={title} key={group}>
            <header><div><h2>{title}<span>{funds.length}</span></h2><p>{description}</p></div></header>
            <div className="fund-list-columns" aria-hidden="true"><span>Fund</span><span>Return</span><span>Assets</span></div>
            <div className="fund-list">{funds.map(fund => <FundRow key={fund.slug} fund={fund} returnTo={returnTo} />)}</div>
          </section>
        );
      })}
    </main>
  );
}
