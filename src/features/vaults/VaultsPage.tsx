import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getPortfolioStatus, getPortfolios } from '../../lib/api';
import type { Portfolio, PortfolioStatus } from '../../lib/api';
import { formatUsdE8, shortAddress } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import { useSession } from '../../store/session';
import { MOCK_FUNDS } from '../../data/mock-funds';
import type { MockFund } from '../../data/mock-funds';
import { AssetLogos } from '../../components/AssetLogo';
import { Badge, ErrorNote, Spinner } from '../../components/ui';


function RebalanceLabel({ value }: { value: MockFund['rebalance'] }): ReactNode {
  if (value === 'none') return <>None</>;
  if (value === 'drift') return <>On drift</>;
  return <>Monthly</>;
}

/** Risk 用 badge 而不是 `.fund-row-return strong` —— 那一格是 25px 等寬字，設計給報酬率數字用的。 */
function RiskBadge({ risk }: { risk: MockFund['risk'] }): ReactNode {
  const tone = risk === 'High' ? 'badge--bad' : risk === 'Medium' ? 'badge--warn' : 'badge--ok';
  return <span className={`badge ${tone}`}>{risk}</span>;
}

function AllocationDetails({ fund }: { fund: MockFund }): ReactNode {
  return (
    <details className="fund-row-details">
      <summary>Allocation &amp; rules</summary>
      <div className="fund-row-rules">
        <div>
          <h4>Target allocation</h4>
          <div className="fund-targets">
            {fund.holdings.map((holding) => (
              <span key={holding.symbol}>
                {holding.symbol} <b>{(holding.weightBps / 100).toFixed(1)}%</b>
              </span>
            ))}
          </div>
        </div>
        <div>
          <h4>Strategy</h4>
          <p>{fund.thesis}</p>
          <p>
            Target-weight rebalancing; every leg is <em>asset ↔ USDT</em>. Risk {fund.risk}, rebalance{' '}
            <RebalanceLabel value={fund.rebalance} />.
          </p>
        </div>
      </div>
    </details>
  );
}

/** 範例基金：只有結構（權重、風險、節奏），**沒有**績效數字。 */
function MockFundRow({ fund }: { fund: MockFund }): ReactNode {
  const preview = fund.holdings.slice(0, 4);
  return (
    <article className="fund-row">
      <div className="fund-row-link" style={{ cursor: 'default' }}>
        <div className="fund-row-identity">
          <span className="fund-mark">
            {fund.portrait === undefined ? (
              fund.mark
            ) : (
              <img className="fund-portrait" src={`/logos/people/${fund.portrait}.jpg`} alt="" loading="lazy" />
            )}
          </span>
          <div>
            <h3>{fund.name}</h3>
            <span className="fund-row-meta">
              {fund.kind}
              <span>· Example</span>
            </span>
            <p className="fund-row-thesis">{fund.subtitle}</p>
          </div>
        </div>

        <div className="fund-row-assets">
          <AssetLogos symbols={preview.map((holding) => holding.symbol)} />
          <span>
            {fund.holdings
              .slice(0, 3)
              .map((holding) => holding.symbol)
              .join(' · ')}
            {fund.holdings.length > 3 ? ` +${fund.holdings.length - 3}` : ''}
          </span>
        </div>

        {/* 這一格在設計稿裡是 25px 等寬的報酬率數字；我們沒有績效資料，所以放 Risk badge。
            不放一個假的百分比 —— 那會是這個頁面最容易騙人的一個數字。 */}
        <div className="fund-row-return">
          <span className="fund-row-label">Risk</span>
          <RiskBadge risk={fund.risk} />
        </div>

        {/* `.fund-row-drop > .fund-row-label` 在設計稿裡是 `display:none`，所以這裡不放 label。 */}
        <div className="fund-row-drop">
          <RebalanceLabel value={fund.rebalance} />
        </div>

        {/* mock 基金不能買，所以沒有箭頭（設計稿的箭頭是「進去看」）。留空格讓五欄對齊。 */}
        <span className="fund-row-arrow" aria-hidden="true" />
      </div>
      <AllocationDetails fund={fund} />
    </article>
  );
}

/** 真投組：有漂移就顯示漂移，沒登入就顯示「登入後可看」。 */
function LiveRow({ portfolio, status }: { portfolio: Portfolio; status: PortfolioStatus | undefined }): ReactNode {
  const account = portfolio.smartAccounts[0];
  const needs = status?.drift.needsRebalance;
  // 空倉的漂移是 drift.ts 對 total = 0 的定義值（5000 bps），不是「嚴重偏離」。
  // 直接顯示 5000 會讓人以為要爆炸；這裡把它講成它真正代表的事：還沒入金。
  const empty = status !== undefined && status.totalUsdE8 === '0';
  return (
    <article className="fund-row">
      <Link className="fund-row-link" to={`/portfolios/${portfolio.id}`}>
        <div className="fund-row-identity">
          <span className="fund-mark">#{portfolio.id}</span>
          <div>
            <h3>{portfolio.strategyName ?? `Strategy ${portfolio.strategyId}`}</h3>
            <span className="fund-row-meta">
              <Badge tone="ok">LIVE</Badge>
              <span>v{portfolio.version}</span>
              <span className="fund-row-creator mono">
                {account === undefined ? '—' : shortAddress(account.address)}
              </span>
            </span>
            <p className="fund-row-thesis">
              {status === undefined
                ? 'Reading on-chain state…'
                : `Targets ${status.targets.map((target) => `${target.symbol} ${(target.weightBps / 100).toFixed(1)}%`).join(' · ')}`}
            </p>
          </div>
        </div>

        <div className="fund-row-assets">
          <AssetLogos symbols={(status?.targets ?? []).map((target) => target.symbol)} />
          <span>
            {status === undefined
              ? '—'
              : status.targets.map((target) => target.symbol).join(' · ')}
          </span>
        </div>

        <div className="fund-row-return">
          <span className="fund-row-label">{empty ? 'State' : 'Drift'}</span>
          <strong className={status === undefined ? 'muted' : empty ? 'muted' : needs === true ? 'neg' : 'pos'}>
            {status === undefined ? '—' : empty ? 'Empty' : `${status.drift.grossDriftBps} bps`}
          </strong>
        </div>

        <div className="fund-row-drop">
          <span className="fund-row-label">Value</span>
          <span>{status === undefined ? '—' : formatUsdE8(status.totalUsdE8)}</span>
        </div>

        <span className="fund-row-arrow" aria-hidden="true">
          ↗
        </span>
      </Link>
    </article>
  );
}

export function VaultsPage(): ReactNode {
  useBodyClass('vault-directory', 'fund-explore');
  const token = useSession((state) => state.token);
  const [query, setQuery] = useState('');

  const portfolios = useQuery({
    queryKey: queryKeys.portfolios(token),
    queryFn: () => getPortfolios(token as string),
    enabled: token !== null,
  });

  // 每一列都要 `/status`（掃日誌＋讀池＋定價，實測 2–3 秒），所以**並行**發；序列會變成 4–6 秒。
  const statuses = useQueries({
    queries: (portfolios.data ?? []).map((portfolio) => ({
      queryKey: queryKeys.status(token, portfolio.id),
      queryFn: () => getPortfolioStatus(token as string, portfolio.id),
      enabled: token !== null,
    })),
  });

  const needle = query.trim().toLowerCase();
  const visibleFunds = useMemo(() => {
    if (needle === '') return MOCK_FUNDS;
    return MOCK_FUNDS.filter(
      (fund) =>
        fund.name.toLowerCase().includes(needle) ||
        fund.symbol.toLowerCase().includes(needle) ||
        fund.thesis.toLowerCase().includes(needle) ||
        fund.holdings.some((holding) => holding.symbol.toLowerCase().includes(needle)),
    );
  }, [needle]);

  const liveRows = (portfolios.data ?? []).map((portfolio, index) => (
    <LiveRow key={portfolio.id} portfolio={portfolio} status={statuses[index]?.data} />
  ));

  return (
    <main className="explore-wrap">
      <header className="explore-heading">
        <div>
          <h1>
            Explore funds<span>.</span>
          </h1>
          <p>
            <strong>Live</strong> funds are real portfolios on BNB Chain — open one to see drift and rebalance it.
            Everything under Example funds is a structural example: allocations and rules only, no performance.
          </p>
        </div>
        <div className="explore-heading-actions">
          <Link className="btn" to="/create">
            Create a fund <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </header>

      <p className="explore-disclosure">
        Example funds · allocations and rules from the design mock · no simulated returns
      </p>

      <div className="explore-toolbar">
        <label className="explore-search">
          {/* 設計稿的 `.explore-search` 是固定 190px 的膠囊，內含一顆放大鏡；placeholder 太長會被截掉。 */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4 4" />
          </svg>
          <input
            type="search"
            placeholder="Search funds"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search funds"
          />
        </label>
        <span className="muted" style={{ fontSize: 13 }}>
          {visibleFunds.length} example funds
          {(portfolios.data ?? []).length === 0 ? '' : ` · ${(portfolios.data ?? []).length} live`}
        </span>
      </div>

      <section className="explore-collection" aria-label="Live funds">
        <header>
          <h2>Live on this deployment</h2>
        </header>

        {/* 查詢失敗必須看得見：不然「讀不到」與「你沒有投組」在畫面上完全一樣。 */}
        <ErrorNote error={portfolios.error} />
        {portfolios.error !== null && portfolios.error !== undefined ? null : token === null ? (
          <div className="directory-empty">
            <strong>No wallet connected</strong>
            <p>
              <Link to="/login">Sign in</Link> to see the portfolios your wallet owns.
            </p>
          </div>
        ) : portfolios.isPending ? (
          <div className="fund-list-loading">
            <Spinner /> <span className="muted">Loading portfolios…</span>
          </div>
        ) : liveRows.length === 0 ? (
          <div className="directory-empty">
            <strong>No funds yet</strong>
            <p>
              This wallet owns no portfolios. <Link to="/create">Create one</Link>.
            </p>
          </div>
        ) : (
          liveRows
        )}
      </section>

      <section className="explore-collection" aria-label="Example funds">
        <header>
          <h2>Example funds</h2>
        </header>
        {visibleFunds.length === 0 ? (
          <div className="directory-empty">
            <strong>No matches</strong>
            <p>No example fund matches “{query}”.</p>
          </div>
        ) : (
          visibleFunds.map((fund) => <MockFundRow key={fund.slug} fund={fund} />)
        )}
      </section>
    </main>
  );
}
