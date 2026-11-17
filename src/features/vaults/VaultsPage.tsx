import { AppIcon } from "../../components/AppIcon";
import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { AppBottomSheet } from "../../components/AppBottomSheet";
import { useMobile } from "../../lib/use-mobile";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useBodyClass } from "../../lib/use-body-class";
import { LISTED_FUNDS } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import { catalogueTwin, symbolOf, synthesizeCommunityFund } from "../../lib/community-fund";
import {
  COLLECTIONS,
  ASSET_CLASSES,
  selectFunds,
} from "../../reference/lib/fund-explore";
import { exploreFilters, type ExploreFilters } from "../../reference/lib/fund-navigation";
import { BoardRow, FeaturedCard, longestHistory } from "./FundBoard";
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getStrategy, listStrategies } from "../../lib/api";
import { shortAddress } from "../../lib/format";
import { useAccountAddress } from "../../lib/use-connected-session";

const hiddenCommunityStrategies = new Map<number, string>([
  [1, "Elon Universe"],
  [2, "BNB 生態平衡"],
]);

export function VaultsPage() {
  useBodyClass(
    "vault-directory",
    "fund-explore",
    "atp-formal-market",
    "atp-complete-market",
  );
  const mobile = useMobile();
  const [draft, setDraft] = useState<ExploreFilters | null>(null);
  const [params, setParams] = useSearchParams(),
    location = useLocation(),
    filters = exploreFilters(new URL(location.pathname + location.search, window.location.origin).href);
  const filterUrl = (key: string, value: string, current = params) => {
    const next = new URLSearchParams(current);
    if (key === "assets") next.delete("asset");
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    return next;
  };
  const change = (key: string, value: string) =>
    setParams(filterUrl(key, value, new URLSearchParams(window.location.search)), {
      replace: true,
    });
  const closeOnBlur = (event: FocusEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget))
      event.currentTarget.open = false;
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== "Escape") return;
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  };
  if (
    !params.has("assets") &&
    ["stocks", "crypto", "rwa"].includes(params.get("asset") || "")
  )
    filters.assets = [params.get("asset")!];
  if (params.get("sort") === "name") filters.sort = "name";
  const visible = selectFunds(
    LISTED_FUNDS,
    filters.q,
    filters.category,
    filters.sort,
    filters.period,
    filters.assets as ("stocks" | "crypto" | "rwa")[],
  );
  if (filters.sort === "name")
    visible.sort((a, b) => a.name.localeCompare(b.name));
  /**
   * 「Live on CRE8」= 鏈上真的存在、有人可以認購的 ATP 策略。
   *
   * 為什麼要另開一個區塊，而不是塞進下面的參考基金目錄：
   * `REFERENCE_FUNDS` 是 30 檔**示範資料**（`Example funds · Reconstructed or simulated
   * performance`）。使用者在 `/create` 建出來的策略是另一種東西 —— 它有自己的鏈上 id、
   * 自己的版本與目標配置。把兩者混在同一份清單裡，會讓人以為示範基金也能下單。
   *
   * `GET /strategies` 是公開端點（實測未帶 token 也回 200），所以這裡用空 token 呼叫；
   * `request()` 在 token 是空字串時不會送 Authorization 標頭。
   */
  const strategies = useQuery({
    queryKey: ["strategies", "public"],
    queryFn: () => listStrategies(""),
    select: (data) => data.items,
  });
  const wallet = useAccountAddress();
  const strategySearch = filters.q.trim().toLowerCase();
  const live = filters.category === "all"
    ? (strategies.data ?? []).filter(
        (strategy) =>
          hiddenCommunityStrategies.get(strategy.id) !== strategy.name &&
          // 跟參考目錄同名的鏈上策略（測試網上架的 16 檔）已經以正式基金出現在自己的分類
          // （Public figures、X voices、Themes…），點進去買的也是同一檔；不在 Community 重複列一次（使用者 2026-11-17）。
          catalogueTwin(strategy.name) === undefined &&
          strategy.name.toLowerCase().includes(strategySearch),
      )
    : [];
  // 每個策略的版本與目標配置要另外問一次（`GET /strategies/:id` 也是公開端點）。
  const details = useQueries({
    queries: live.map((strategy) => ({
      queryKey: ["strategy", "public", strategy.id],
      queryFn: () => getStrategy("", strategy.id),
      staleTime: 60_000,
    })),
  });

  /**
   * 把 ATP 策略偽裝成 `ReferenceFund`，好讓它們用**同一份** `BoardRow` 呈現。
   *
   * 為什麼要借用 `BoardRow`：使用者要求 Community 區塊「跟其他基金一樣的樣式」。
   * 自己複製一份 markup 的話，參考基金那邊改一次樣式就得同步改這裡 —— 遲早不同步。
   *
   * 哪些是真的、哪些是編的（刻意寫清楚，免得下一個人以為這些報酬是實績）：
   *   真的：名稱、建立者、鏈上 id、目標配置（資產與權重）、成立天數
   *   編的：NAV 曲線與各期間報酬 —— ATP 目前沒有基金層級的歷史 NAV，
   *         所以用「依權重與固定種子的確定性亂數」生成，同一個策略永遠長一樣，不會每次重整跳動。
   */
  const community = useMemo(
    () =>
      live.map((strategy, index) => {
        const version = details[index]?.data?.versions?.[0];
        const allocation = version?.allocation?.assets ?? [];
        const symbols = allocation.map((asset) => symbolOf(asset.address));
        const positions = allocation.map((asset, i) => ({
          p: symbols[i] ?? 'USDT',
          loc: symbols[i] ?? 'USDT',
          w: asset.weightBps / 100,
        }));
        return synthesizeCommunityFund({
          id: strategy.id,
          name: strategy.name,
          provider: strategy.provider,
          onchainId: strategy.onchainId,
          description: strategy.description,
          createdAt: strategy.createdAt,
          positions,
          // seed 用 strategy.id，與詳情頁（`/funds/strategy/:id`）一致 ——
          // 用陣列 index 的話，列表與詳情會算出**不同**的報酬（實測 +19.15% vs −23.81%）。
          seed: strategy.id,
        });
      }),
    // `details` 每次 render 都是新陣列，用它當依賴會無限重算 —— 用「已載入的版本數」當訊號。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, details.map((row) => row.data?.versions?.[0]?.version ?? 0).join(",")],
  );

  const returnTo = location.pathname + location.search;
  const controls = mobile && draft ? draft : filters;
  const countFilters = (value: ExploreFilters) => value.assets.length + Number(value.period !== "1Y") + Number(value.sort !== "perf");
  const resultCount = draft
    ? selectFunds(LISTED_FUNDS, draft.q, draft.category, draft.sort, draft.period, draft.assets as ("stocks" | "crypto" | "rwa")[]).length
    : visible.length;
  const applyFilters = () => {
    if (!draft) return;
    const next = filterUrl("assets", draft.assets.join(","));
    if (draft.period === "1Y") next.delete("period");
    else next.set("period", draft.period);
    if (draft.sort === "perf") next.delete("sort");
    else next.set("sort", draft.sort);
    setParams(next, { replace: true });
    setDraft(null);
  };
  const periodLabel = filters.period === "ALL" ? "All time" : filters.period;
  const fundUrl = (slug: string) =>
    `/funds/${slug}?period=${filters.period}&returnTo=${encodeURIComponent(returnTo)}`;
  const boardTitle = filters.category === "all"
    ? "All funds"
    : COLLECTIONS.find((collection) => collection.id === filters.category)?.name ?? "Funds";
  const deck = useRef<HTMLOListElement>(null);
  /** 往左或往右滑一張牌的距離（牌寬 + 間距）。 */
  const slideDeck = (direction: 1 | -1) => {
    const list = deck.current, card = list?.querySelector("li");
    if (!list || !card) return;
    list.scrollBy({ left: direction * (card.getBoundingClientRect().width + 16), behavior: "smooth" });
  };
  const fullDays = longestHistory(LISTED_FUNDS, filters.period);
  // 主打 = 目前分類裡報酬最高的六檔（一副可以左右滑的牌）。只有在「沒搜尋、沒篩資產、依報酬排序」時才成立，
  // 否則上面三檔和下面的榜會講兩件不同的事。榜不到十檔時也不放：七檔裡挑六檔「主打」沒有意義。
  const featured = filters.q.trim() === "" && filters.assets.length === 0 && filters.sort === "perf" && visible.length >= 10
    ? (visible.slice(0, 6) as ReferenceFund[])
    : [];
  const categories = (
    <nav className="collection-tabs" aria-label="Fund categories">
      {[{ id: "all", name: "All" }, ...COLLECTIONS].map((category) => (
        <Link
          key={category.id}
          to={{ pathname: location.pathname, search: filterUrl("category", category.id).toString() }}
          aria-current={filters.category === category.id ? "page" : undefined}
        >
          {category.name}
        </Link>
      ))}
    </nav>
  );
  const assetOptions = ASSET_CLASSES.map(({ id, name }) => (
    <label className="explore-filter-option" key={id}>
      <input
        type="checkbox"
        checked={controls.assets.includes(id)}
        onChange={() => {
          const assets = controls.assets.includes(id)
            ? controls.assets.filter((asset) => asset !== id)
            : [...controls.assets, id];
          if (mobile && draft) setDraft({ ...draft, assets });
          else change("assets", assets.join(","));
        }}
      />
      <span>{name}</span>
      {mobile && (
        <span className="app-filter-check" aria-hidden="true">
          <AppIcon name="check" size={15} />
        </span>
      )}
    </label>
  ));
  const advancedOptions = (
    <>
      <label className="explore-filter-field">
        <span className="app-field-label">Period</span>
        <select value={controls.period} onChange={(e) => {
          if (mobile && draft) setDraft({ ...draft, period: e.target.value as ExploreFilters["period"] });
          else change("period", e.target.value);
        }}>
          {["7D", "30D", "90D", "1Y", "ALL"].map((period) => <option key={period}>{period}</option>)}
        </select>
      </label>
      <label className="explore-filter-field">
        <span className="app-field-label">Sort by</span>
        <select value={controls.sort} onChange={(e) => {
          if (mobile && draft) setDraft({ ...draft, sort: e.target.value });
          else change("sort", e.target.value);
        }}>
          <option value="perf">Highest return</option>
          <option value="dd">Lowest drawdown</option>
          <option value="age">Longest history</option>
          <option value="name">Fund name</option>
        </select>
      </label>
    </>
  );
  const search = (
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
  );
  const filterCount = countFilters(filters);
  return (
    <main className="explore-wrap" id="fund-explore">
      <header className="explore-heading">
        <h1>Explore funds<span>.</span></h1>
      </header>
      {!mobile && categories}
      <div className="explore-toolbar">
        {mobile ? (
          <>
            {search}
            <button
              className="app-filter-trigger"
              type="button"
              aria-haspopup="dialog"
              aria-label={filterCount ? `Filters, ${filterCount} applied` : "Filters"}
              aria-expanded={draft !== null}
              onClick={() => setDraft(filters)}
            >
              <AppIcon name="filter" size={23} />
              {filterCount > 0 && <span className="app-filter-count" aria-hidden="true">{filterCount}</span>}
            </button>
            <AppBottomSheet open={draft !== null} onOpenChange={(open) => { if (!open) setDraft(null); }} title="Filter funds">
              <fieldset className="app-filter-fields">
                <legend>Asset type</legend>
                {assetOptions}
              </fieldset>
              <div className="app-filter-options">{advancedOptions}</div>
              <div className="app-sheet-actions">
                {draft && countFilters(draft) > 0 && (
                  <button className="btn ghost" type="button" onClick={() => setDraft({ ...draft, assets: [], period: "1Y", sort: "perf" })}>
                    Reset
                  </button>
                )}
                <button className="btn primary" type="button" onClick={applyFilters}>
                  Show {resultCount} {resultCount === 1 ? "fund" : "funds"}
                </button>
              </div>
            </AppBottomSheet>
          </>
        ) : (
          <>
            {search}
            {/* 一顆 Filters 收進所有篩選（與手機一致）：原本 Assets、Advanced 兩顆，使用者得先決定要開哪一個。 */}
            <div className="explore-filter-list">
              <details className="explore-filter explore-filter--all" name="fund-filter" onBlur={closeOnBlur} onKeyDown={closeOnEscape}>
                <summary>
                  <AppIcon name="filter" size={16} />Filters
                  {filterCount > 0 && <span className="app-filter-count" aria-label={`${filterCount} applied`}>{filterCount}</span>}
                </summary>
                <div className="explore-filter-panel">
                  <fieldset className="app-filter-fields">
                    <legend>Asset type</legend>
                    {assetOptions}
                  </fieldset>
                  <div className="app-filter-options">{advancedOptions}</div>
                </div>
              </details>
            </div>
          </>
        )}
      </div>
      {mobile && categories}
      {visible.length === 0 && live.length === 0 && (
        <div className="directory-empty app-search-empty">
          <h2>No matches</h2>
        </div>
      )}
      {featured.length > 0 && (
        <section className="mkt-section mkt-deck" aria-label="Top performers">
          <header className="mkt-section-head">
            <h2>Top performers</h2>
            <div className="mkt-deck-nav">
              <span className="mkt-period">{periodLabel} model return</span>
              <button type="button" aria-label="Previous funds" onClick={() => slideDeck(-1)}><AppIcon name="left" size={16} /></button>
              <button type="button" aria-label="Next funds" onClick={() => slideDeck(1)}><AppIcon name="right" size={16} /></button>
            </div>
          </header>
          {/* 一副可以左右滑的牌：觸控直接滑，桌面用箭頭或觸控板。 */}
          <ol className="mkt-features" role="list" ref={deck}>
            {featured.map((fund, index) => (
              <FeaturedCard key={fund.slug} fund={fund} period={filters.period} url={fundUrl(fund.slug)} rank={index + 1} fullDays={fullDays} />
            ))}
          </ol>
        </section>
      )}
      {community.length > 0 && (
        <section className="mkt-section" aria-label="Community">
          <header className="mkt-section-head">
            <h2>Community<span>{community.length}</span></h2>
            <span className="mkt-period mkt-period--long">Created on CRE8 · modelled until live history</span>
          </header>
          {/* 社群策略的走勢是依權重生成的示意（見上方 community 的註解），所以不排名、不和參考基金混在同一張榜。 */}
          <ol className="mkt-board" role="list">
            {community.map((fund, index) => {
              const strategy = live[index];
              const yours = wallet !== null && strategy?.provider?.toLowerCase() === wallet.toLowerCase();
              return (
                <BoardRow
                  key={strategy?.id ?? fund.slug}
                  fund={fund}
                  period={filters.period}
                  // 用策略 id 連結：有同名參考基金時 fund.slug 是參考目錄的 slug，不是 community-<id>。
                  url={`/strategies/${strategy?.id ?? fund.slug.replace("community-", "")}`}
                  rank={null}
                  meta={
                    <>
                      {yours ? "Yours" : shortAddress(strategy?.provider ?? fund.manager)}
                      {strategy?.onchainId != null ? ` · On-chain #${strategy.onchainId}` : ""}
                    </>
                  }
                />
              );
            })}
          </ol>
        </section>
      )}
      {visible.length > 0 && (
        <section className="mkt-section" aria-label={boardTitle}>
          <header className="mkt-section-head">
            <h2>{boardTitle}<span>{visible.length}</span></h2>
            {/* 期間直接在榜上切換：原本要先打開 Filters 才找得到。 */}
            <div className="seg public-periods mkt-periods" role="group" aria-label="Return period">
              {(["7D", "30D", "90D", "1Y", "ALL"] as const).map((period) => (
                <button key={period} type="button" className={period === filters.period ? "on" : ""}
                  aria-pressed={period === filters.period}
                  onClick={() => change("period", period === "1Y" ? "" : period)}>
                  {period === "ALL" ? "All" : period}
                </button>
              ))}
            </div>
          </header>
          <div className="mkt-board-head" aria-hidden="true">
            <span>#</span>
            <span>Fund</span>
            <span>Holdings</span>
            <span>Trend</span>
            <button type="button" tabIndex={-1} aria-pressed={filters.sort === "perf"} onClick={() => change("sort", "")}>
              Model return
            </button>
            <button type="button" tabIndex={-1} aria-pressed={filters.sort === "dd"} onClick={() => change("sort", "dd")}>
              Max drawdown
            </button>
          </div>
          <ol className="mkt-board" role="list">
            {visible.map((fund, index) => (
              <BoardRow
                key={fund.slug}
                fund={fund as ReferenceFund}
                period={filters.period}
                url={fundUrl(fund.slug)}
                rank={index + 1}
                fullDays={fullDays}
              />
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
