import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getPortfolioStatus, getPortfolios } from '../../lib/api';
import type { Portfolio, PortfolioStatus } from '../../lib/api';
import { formatUsdE8, shortAddress } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useSession } from '../../store/session';
import { MOCK_FUNDS } from '../../data/mock-funds';
import type { MockFund } from '../../data/mock-funds';
import { Badge, Spinner } from '../../components/ui';

/** 三個字的縮寫，給 `fund-mark` 用（沒有 symbol 圖示時的替代）。 */
function markOf(fund: MockFund): string {
  return fund.symbol;
}

function RebalanceLabel({ value }: { value: MockFund['rebalance'] }): ReactNode {
  return <>{value === 'none' ? '不自動' : value === 'drift' ? '偏離觸發' : '每月'}</>;
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
          <p>
            目標權重再平衡：偏離門檻時，把超配的資產換成低配的（每條腿都是「資產 ↔ USDT」）。
            風險等級 {fund.risk}。
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
          <span className="fund-mark">{markOf(fund)}</span>
          <div>
            <h3>{fund.name}</h3>
            <span className="fund-row-meta">
              Indexed fund
              <span className="fund-row-creator">範例</span>
            </span>
            <p className="fund-row-thesis">{fund.thesis}</p>
          </div>
        </div>

        <div className="fund-row-assets">
          <span className="fund-row-logos">
            {preview.map((holding) => (
              <span key={holding.symbol} className="badge" style={{ height: 20, fontSize: 10 }}>
                {holding.symbol}
              </span>
            ))}
          </span>
          <span>
            {fund.holdings
              .slice(0, 3)
              .map((holding) => holding.symbol)
              .join(' · ')}
            {fund.holdings.length > 3 ? ` +${fund.holdings.length - 3}` : ''}
          </span>
        </div>

        <div className="fund-row-return">
          <span className="fund-row-label">Risk</span>
          <strong className={fund.risk === 'High' ? 'neg' : 'muted'}>{fund.risk}</strong>
        </div>

        <div className="fund-row-drop">
          <span className="fund-row-label">Rebalance</span>
          <span>
            <RebalanceLabel value={fund.rebalance} />
          </span>
        </div>

        <span className="fund-row-arrow" aria-hidden="true">
          ·
        </span>
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
            <h3>
              策略 {portfolio.strategyId} · v{portfolio.version}
            </h3>
            <span className="fund-row-meta">
              <Badge tone="ok">LIVE</Badge>
              <span className="fund-row-creator mono">
                {account === undefined ? '—' : shortAddress(account.address)}
              </span>
            </span>
            <p className="fund-row-thesis">
              {status === undefined
                ? '讀取鏈上狀態中…'
                : `目標 ${status.targets.map((target) => `${target.symbol} ${(target.weightBps / 100).toFixed(1)}%`).join(' · ')}`}
            </p>
          </div>
        </div>

        <div className="fund-row-assets">
          <span className="fund-row-logos">
            {(status?.targets ?? []).map((target) => (
              <span key={target.asset} className="badge" style={{ height: 20, fontSize: 10 }}>
                {target.symbol}
              </span>
            ))}
          </span>
          <span>
            {status === undefined
              ? '—'
              : status.targets.map((target) => target.symbol).join(' · ')}
          </span>
        </div>

        <div className="fund-row-return">
          <span className="fund-row-label">{empty ? 'State' : 'Drift'}</span>
          <strong className={status === undefined ? 'muted' : empty ? 'muted' : needs === true ? 'neg' : 'pos'}>
            {status === undefined ? '—' : empty ? '尚未入金' : `${status.drift.grossDriftBps} bps`}
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
            真的投組（LIVE）在鏈上，可以按進去執行再平衡；其餘是<strong>範例基金</strong>，只有結構、沒有績效數字。
          </p>
        </div>
        <div className="explore-heading-actions">
          <Link className="btn" to="/create">
            Create a fund <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </header>

      <p className="explore-disclosure">
        Example funds · 權重與規則取自設計稿的 mock 定義 · 未模擬報酬率
      </p>

      <div className="explore-toolbar">
        <label className="explore-search">
          <input
            type="search"
            placeholder="搜尋基金、代號或持股…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜尋基金"
          />
        </label>
        <span className="muted" style={{ fontSize: 13 }}>
          {visibleFunds.length} 個範例基金
          {(portfolios.data ?? []).length === 0 ? '' : ` · ${(portfolios.data ?? []).length} 個真投組`}
        </span>
      </div>

      <section className="explore-collection" aria-label="Live funds">
        <header>
          <h2>Live on this deployment</h2>
        </header>

        {token === null ? (
          <div className="directory-empty">
            登入後才會看到你在鏈上的投組。<Link to="/login">先登入</Link>
          </div>
        ) : portfolios.isPending ? (
          <div className="fund-list-loading">
            <Spinner /> <span className="muted">讀取投組…</span>
          </div>
        ) : liveRows.length === 0 ? (
          <div className="directory-empty">
            這個錢包還沒有投組。<Link to="/create">建立第一個</Link>
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
          <div className="directory-empty">沒有符合「{query}」的基金</div>
        ) : (
          visibleFunds.map((fund) => <MockFundRow key={fund.slug} fund={fund} />)
        )}
      </section>
    </main>
  );
}
