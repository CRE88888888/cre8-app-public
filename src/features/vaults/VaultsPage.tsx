import { AppIcon } from "../../components/AppIcon";
import { useMemo } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useBodyClass } from "../../lib/use-body-class";
import { catalogueTwin, symbolOf, synthesizeCommunityFund } from "../../lib/community-fund";
import { exploreFilters } from "../../reference/lib/fund-navigation";
import { FundTile } from "./FundTile";
import { fundArt } from "../../lib/fund-art";
import { estimatedApy, navFromApi } from "../../lib/estimated-apy";
import { getStrategy, listStrategies } from "../../lib/api";
import { groupFunds } from "../../lib/fund-categories";

const hiddenCommunityStrategies = new Map<number, string>([
  [1, "Elon Universe"],
  [2, "BNB 生態平衡"],
]);

/**
 * 基金列表（使用者 2026-11-20，首發 21 檔）：只列 `GET /strategies` 的公開基金，依後端 `category` 分成
 * Themes／People／Leveraged，沒分類的放最後。
 *
 * - App 內建的 16 檔示範目錄不再當列表（後端只留 Mag7，其他隱藏）；資料留著，舊連結會顯示已下架（FundPage）。
 * - 有 `catalogKey` 對應到目錄的（Mag7）沿用目錄的封面與資料；其他基金不顯示模擬報酬，報酬欄是「—」。
 * - `GET /strategies` 是公開端點，用空 token 呼叫（`request()` 不送 Authorization）。
 * - 正式版面等整站重新設計。
 */
export function VaultsPage() {
  useBodyClass(
    "vault-directory",
    "fund-explore",
    "atp-formal-market",
    "atp-complete-market",
  );
  const [, setParams] = useSearchParams(),
    location = useLocation(),
    filters = exploreFilters(new URL(location.pathname + location.search, window.location.origin).href);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(window.location.search);
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const strategies = useQuery({
    queryKey: ["strategies", "public"],
    queryFn: () => listStrategies(""),
    select: (data) => data.items,
  });
  const search = filters.q.trim().toLowerCase();
  const live = (strategies.data ?? []).filter(
    (strategy) =>
      hiddenCommunityStrategies.get(strategy.id) !== strategy.name &&
      strategy.name.toLowerCase().includes(search),
  );
  // 每檔的目標配置要另外問一次（`GET /strategies/:id` 也是公開端點）。
  const details = useQueries({
    queries: live.map((strategy) => ({
      queryKey: ["strategy", "public", strategy.id],
      queryFn: () => getStrategy("", strategy.id),
      staleTime: 60_000,
    })),
  });

  const rows = useMemo(
    () =>
      live.map((strategy, index) => {
        const version = details[index]?.data?.versions?.[0];
        const allocation = version?.allocation?.assets ?? [];
        const positions = allocation.map((asset) => {
          const symbol = symbolOf(asset.address);
          return { p: symbol, loc: symbol, w: asset.weightBps / 100 };
        });
        const fund = synthesizeCommunityFund({
          id: strategy.id,
          name: strategy.name,
          provider: strategy.provider,
          onchainId: strategy.onchainId,
          description: strategy.description,
          createdAt: strategy.createdAt,
          positions,
          catalogKey: strategy.catalogKey,
        });
        const twin = catalogueTwin(strategy.catalogKey) !== undefined;
        // 推估年化：後端模型淨值（backend#173）優先；還沒有的話，目錄基金用內建回測。
        const nav = navFromApi(details[index]?.data?.modelNav);
        const apy = estimatedApy(nav.length > 1 ? nav : twin ? fund.nav : null);
        return { strategy, fund, twin, apy, category: strategy.category };
      }),
    // `details` 每次 render 都是新陣列，用它當依賴會無限重算 —— 用「已載入的版本數」當訊號。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.map((strategy) => strategy.id).join(","), details.map((row) => `${row.data?.versions?.[0]?.version ?? 0}:${row.data?.modelNav?.length ?? 0}`).join(",")],
  );
  // 後端由新到舊回傳；組內照上架名單的順序（id 由小到大，Mag7 在最前面）。
  const groups = groupFunds([...rows].sort((a, b) => a.strategy.id - b.strategy.id));
  const returnTo = location.pathname + location.search;
  const fundUrl = (row: (typeof rows)[number]) =>
    row.twin
      ? `/funds/${row.fund.slug}?returnTo=${encodeURIComponent(returnTo)}`
      : `/strategies/${row.strategy.id}`;
  return (
    <main className="explore-wrap" id="fund-explore">
      <header className="explore-heading lp-hero">
        <h1>Own the idea you believe in.</h1>
        <p>Pick a fund and an amount. Your USDT becomes the stocks and tokens behind it, in an account only you control.</p>
      </header>
      <div className="explore-toolbar lp-toolbar">
        <label className="explore-search">
          <AppIcon name="search" size={19} />
          <input
            type="search"
            aria-label="Filter funds"
            placeholder="Search funds"
            value={filters.q}
            onChange={(e) => change("q", e.target.value)}
          />
        </label>
      </div>
      {strategies.isPending && (
        <div className="directory-empty app-search-empty" role="status">
          <h2>Loading funds…</h2>
        </div>
      )}
      {strategies.isError && (
        <div className="directory-empty app-search-empty" role="alert">
          <h2>Funds could not be loaded</h2>
          <button type="button" className="btn ghost" onClick={() => void strategies.refetch()}>Try again</button>
        </div>
      )}
      {strategies.isSuccess && groups.length === 0 && (
        <div className="directory-empty app-search-empty">
          <h2>No matches</h2>
        </div>
      )}
      {groups.map((group) => (
        <section className="lp-sec" aria-label={group.name} key={group.id} data-group={group.id}>
          <header className="lp-head">
            <h2>{group.name}<span>{group.items.length}</span></h2>
          </header>
          <ol className={`lp-tiles lp-tiles--${group.id}`} role="list">
            {group.items.map((row) => (
              <FundTile
                key={row.strategy.id}
                fund={row.fund}
                art={fundArt(row.strategy.catalogKey)}
                url={fundUrl(row)}
                apy={row.apy}
              />
            ))}
          </ol>
        </section>
      ))}
    </main>
  );
}
