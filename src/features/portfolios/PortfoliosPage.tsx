import { useQueries, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getPortfolioActivity, getPortfolioStatus, getPortfolios } from '../../lib/api';
import type { PortfolioActivity } from '../../lib/api';
import { formatUsdE8, shortAddress } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import { useConnectedSessionToken } from '../../lib/use-connected-session';
import { useWallet } from '../../store/wallet';
import { MOCK_FUNDS } from '../../data/mock-funds';
import { Badge, ErrorNote, Spinner } from '../../components/ui';
import { WalletMenu } from '../../components/WalletMenu';

/**
 * 投組頁。照參考站 `portfolio.html` 的區塊順序：
 * `Portfolio` → `Your funds` → `Activity`，資料換成我們真的擁有的東西。
 *
 * 參考站是「一個錢包持有多檔基金的 shares」；我們的模型是「一個錢包持有多個 portfolio，
 * 每個 portfolio 是一個策略的實例」。所以：
 *   Your funds      = 這個錢包的 portfolio 清單（總值、漂移、帳戶）
 *   Activity        = 各投組的執行紀錄合併，新到舊（含前後快照的漂移）
 *   點進去看細節    = `/portfolios/:id`（持倉、目標、再平衡、session key、approve）
 */
export function PortfoliosPage(): ReactNode {
  useBodyClass('portfolio-page', 'fund-explore');
  const token = useConnectedSessionToken();
  const address = useWallet((state) => state.address);

  const portfolios = useQuery({
    queryKey: queryKeys.portfolios(token),
    queryFn: () => getPortfolios(token as string),
    enabled: token !== null,
  });

  const ids = (portfolios.data ?? []).map((portfolio) => portfolio.id);

  const statuses = useQueries({
    queries: ids.map((id) => ({
      queryKey: queryKeys.status(token, id),
      queryFn: () => getPortfolioStatus(token as string, id),
      enabled: token !== null,
    })),
  });

  const activities = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['activity', token, id],
      queryFn: () => getPortfolioActivity(token as string, id),
      enabled: token !== null,
    })),
  });

  const totalUsdE8 = statuses.reduce((sum, row) => sum + BigInt(row.data?.totalUsdE8 ?? '0'), 0n);

  // 合併所有投組的執行紀錄，新到舊。`portfolioId` 要留著才知道是哪一檔。
  const merged: { portfolioId: number; entry: PortfolioActivity }[] = activities.flatMap((row, index) => {
    const portfolioId = ids[index];
    if (portfolioId === undefined) return [];
    return (row.data?.activity ?? []).map((entry) => ({ portfolioId, entry }));
  });
  merged.sort((left, right) => right.entry.id - left.entry.id);

  const nameOf = new Map((portfolios.data ?? []).map((portfolio) => [portfolio.id, portfolio.strategyName]));
  /**
   * 這個 portfolio 應該連到哪裡。
   *
   * 為什麼不是一律連 `/funds/:slug`：那條路由只認**參考基金**（30 檔示範資料，來自
   * `bnb-public` 的目錄）。使用者自己建的策略（例如「BNB 生態平衡」）在裡面找不到同名條目，
   * 於是舊程式把它連到 `/vaults` —— 等於把使用者丟回一個**不含他的基金**的目錄，看起來就像
   * 「我建的基金不見了」（實測回報）。
   *
   * 有參考基金 → 走 `/funds/:slug`（含參考版面與說明）；沒有 → 走 `/strategies/:id`
   * （那頁本來就會顯示策略的版本與目標配置）。
   */
  const linkFor = (id: number): string => {
    const slug = MOCK_FUNDS.find((fund) => fund.name === nameOf.get(id))?.slug;
    const strategyId = (portfolios.data ?? []).find((portfolio) => portfolio.id === id)?.strategyId;
    if (slug !== undefined) return `/funds/${slug}`;
    return strategyId === undefined ? '/vaults' : `/strategies/${strategyId}`;
  };

  return (
    <main className="explore-wrap">
      <header className="explore-heading">
        <div>
          <h1>
            Portfolio<span>.</span>
          </h1>
          {token !== null && address !== null && (
            <p>Wallet <span className="mono">{shortAddress(address)}</span></p>
          )}
        </div>
        {token !== null && (
          <div className="explore-heading-actions">
            <Link className="btn" to="/create">
              Create a fund <span aria-hidden="true">↗</span>
            </Link>
          </div>
        )}
      </header>

      {token === null ? (
        <div className="directory-empty">
          <p>View your funds and activity.</p>
          <div className="directory-empty-actions">
            <WalletMenu inline />
          </div>
        </div>
      ) : (
        <>
          <ErrorNote error={portfolios.error} />

          <section className="explore-collection" aria-label="Your funds">
            <header>
              <div>
                <h2>
                  Your funds<span>{ids.length}</span>
                </h2>
                <p>
                  Total value <strong>{formatUsdE8(totalUsdE8.toString())}</strong> across {ids.length} smart
                  account{ids.length === 1 ? '' : 's'}.
                </p>
              </div>
            </header>

            {portfolios.isPending ? (
              <div className="fund-list-loading">
                <Spinner /> <span className="muted">Loading portfolios…</span>
              </div>
            ) : ids.length === 0 ? (
              <div className="directory-empty">
                <strong>No funds yet</strong>
                <p>
                  This wallet owns no portfolios. <Link to="/create">Create one</Link>.
                </p>
              </div>
            ) : (
              <div className="portfolio-table-scroll" role="region" aria-label="Fund holdings" tabIndex={0}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Fund</th>
                    <th>Account</th>
                    <th className="num">Value</th>
                    <th className="num">Drift</th>
                    <th>State</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ids.map((id, index) => {
                    const status = statuses[index]?.data;
                    const empty = status !== undefined && status.totalUsdE8 === '0';
                    const needs = status?.drift.needsRebalance ?? false;
                    return (
                      <tr key={id}>
                        <td>
                          {/* 名稱 → 目錄 slug：細節頁移除後，這裡是使用者唯一能點進去看基金的地方。 */}
                          {(() => {
                            const name = nameOf.get(id);
                            return name === undefined ? (
                              `Strategy ${id}`
                            ) : (
                              <Link to={linkFor(id)}>{name}</Link>
                            );
                          })()}
                          {/* 這檔基金不在參考目錄裡 = 使用者（或營運端）自己建的策略。
                              標一下，否則「為什麼這檔的頁面長得不一樣」會讓人以為壞了。 */}
                          {MOCK_FUNDS.some((fund) => fund.name === nameOf.get(id)) ? null : (
                            <span className="muted" style={{ fontSize: 11 }}> your strategy</span>
                          )}
                        </td>
                        <td className="mono muted" style={{ fontSize: 12 }}>
                          {status === undefined ? '—' : shortAddress(status.account)}
                        </td>
                        <td className="num">{status === undefined ? '—' : formatUsdE8(status.totalUsdE8 ?? '0')}</td>
                        <td className={`num ${needs ? 'neg' : 'pos'}`}>
                          {status === undefined ? '—' : empty ? 'empty' : `${status.drift.grossDriftBps} bps`}
                        </td>
                        <td>
                          {status === undefined ? (
                            <span className="muted">—</span>
                          ) : empty ? (
                            <Badge tone="warn">Needs funding</Badge>
                          ) : needs ? (
                            <Badge tone="bad">Rebalance due</Badge>
                          ) : (
                            <Badge tone="ok">Aligned</Badge>
                          )}
                        </td>
                        <td>
                          {/* 一律給得出目的地：參考基金走 `/funds/:slug`，自建策略走 `/strategies/:id`。
                              以前這裡對自建策略顯示 `—`（等於「沒有細節可看」），但它其實有策略頁。 */}
                          <Link to={linkFor(id)}>Open →</Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </section>

          <section className="explore-collection" aria-label="Activity">
            <header>
              <div>
                <h2>
                  Activity<span>{merged.length}</span>
                </h2>
                <p>
                  Every round that reached the chain, with the drift measured before and after it (from the
                  snapshots the scheduler writes).
                </p>
              </div>
            </header>

            {merged.length === 0 ? (
              <div className="directory-empty">
                <strong>No activity yet</strong>
                <p>Executed rounds will appear here.</p>
              </div>
            ) : (
              <div className="portfolio-table-scroll" role="region" aria-label="Activity history" tabIndex={0}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Fund</th>
                    <th>When</th>
                    <th>State</th>
                    <th className="num">Drift</th>
                    <th className="num">Value</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {merged.slice(0, 20).map(({ portfolioId, entry }) => (
                    <tr key={`${portfolioId}-${entry.id}`}>
                      <td>
                        {nameOf.get(portfolioId) ?? `#${portfolioId}`}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {new Date(entry.createdAt).toLocaleString('en-GB', { hour12: false })}
                      </td>
                      <td>
                        <Badge tone={entry.state === 'confirmed' ? 'ok' : entry.state === 'failed' ? 'bad' : 'warn'}>
                          {entry.state}
                        </Badge>
                      </td>
                      <td className="num mono" style={{ fontSize: 12 }}>
                        {entry.driftBeforeBps === null || entry.driftAfterBps === null
                          ? '—'
                          : `${entry.driftBeforeBps} → ${entry.driftAfterBps} bps`}
                      </td>
                      <td className="num mono" style={{ fontSize: 12 }}>
                        {entry.usdBeforeE8 === null || entry.usdAfterE8 === null
                          ? '—'
                          : `${formatUsdE8(entry.usdBeforeE8)} → ${formatUsdE8(entry.usdAfterE8)}`}
                      </td>
                      <td className="mono muted" style={{ fontSize: 11 }}>
                        {entry.txHash === null ? '—' : `${entry.txHash.slice(0, 10)}…${entry.txHash.slice(-6)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
