import { ListFilter, Search } from "lucide-react";
import type { FocusEvent, KeyboardEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useBodyClass } from "../../lib/use-body-class";
import { REFERENCE_FUNDS } from "../../lib/public-funds";
import {
  COLLECTIONS,
  ASSET_CLASSES,
  selectFunds,
  collectionOf,
} from "../../reference/lib/fund-explore";
import { exploreFilters } from "../../reference/lib/fund-navigation";
import { FundRow } from "../reference/FundRow";
export function VaultsPage() {
  useBodyClass(
    "vault-directory",
    "fund-explore",
    "atp-formal-market",
    "atp-complete-market",
  );
  const [params, setParams] = useSearchParams(),
    location = useLocation(),
    filters = exploreFilters(window.location.href);
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
    REFERENCE_FUNDS,
    filters.q,
    filters.category,
    filters.sort,
    filters.period,
    filters.assets as ("stocks" | "crypto" | "rwa")[],
  );
  if (filters.sort === "name")
    visible.sort((a, b) => a.name.localeCompare(b.name));
  const returnTo = location.pathname + location.search;
  return (
    <main className="explore-wrap" id="fund-explore">
      <header className="explore-heading">
        <h1>
          Explore funds<span>.</span>
        </h1>
      </header>
      <p className="explore-disclosure">
        Example funds · Reconstructed or simulated performance · Before fees
      </p>
      <nav className="collection-tabs" aria-label="Fund categories">
        {[{ id: "all", name: "All" }, ...COLLECTIONS].map((category) => {
          const query = filterUrl("category", category.id).toString();
          return (
            <Link
              key={category.id}
              to={{ pathname: location.pathname, search: query }}
              aria-current={
                filters.category === category.id ? "page" : undefined
              }
            >
              {category.name}
            </Link>
          );
        })}
      </nav>
      <div className="explore-toolbar">
        <div className="explore-filter-list">
          <details
            className="explore-filter"
            name="fund-filter"
            onBlur={closeOnBlur}
            onKeyDown={closeOnEscape}
          >
            <summary>
              <ListFilter aria-hidden="true" />
              Assets
            </summary>
            <div className="explore-filter-panel">
              {ASSET_CLASSES.map((c) => (
                <label className="explore-filter-option" key={c.id}>
                  <input
                    type="checkbox"
                    checked={filters.assets.includes(c.id)}
                    onChange={() =>
                      change(
                        "assets",
                        filters.assets.includes(c.id)
                          ? filters.assets.filter((a) => a !== c.id).join(",")
                          : [...filters.assets, c.id].join(","),
                      )
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </details>
          <details
            className="explore-filter"
            name="fund-filter"
            onBlur={closeOnBlur}
            onKeyDown={closeOnEscape}
          >
            <summary>
              <ListFilter aria-hidden="true" />
              Advanced
            </summary>
            <div className="explore-filter-panel">
              <label className="explore-filter-field">
                Period
                <select
                  value={filters.period}
                  onChange={(e) => change("period", e.target.value)}
                >
                  {["7D", "30D", "90D", "1Y", "ALL"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="explore-filter-field">
                Sort
                <select
                  value={filters.sort}
                  onChange={(e) => change("sort", e.target.value)}
                >
                  <option value="perf">Highest return</option>
                  <option value="dd">Lowest drawdown</option>
                  <option value="age">Longest history</option>
                  <option value="name">Fund name</option>
                </select>
              </label>
            </div>
          </details>
        </div>
        <label className="explore-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label="Filter funds"
            placeholder="Filter funds"
            value={filters.q}
            onChange={(e) => change("q", e.target.value)}
          />
        </label>
      </div>
      {visible.length === 0 && (
        <div className="directory-empty">
          <h2>No matches</h2>
          <p>Try another name, asset or category.</p>
        </div>
      )}
      {COLLECTIONS.map((c) => {
        const funds = visible.filter((f) => collectionOf(f) === c.id);
        return funds.length ? (
          <section
            className="explore-collection"
            key={c.id}
            aria-label={c.name}
          >
            <header>
              <div>
                <h2>
                  {c.name}
                  <span>{funds.length}</span>
                </h2>
                <p>{c.description}</p>
              </div>
              <span className="explore-current-period">
                {filters.period === "ALL" ? "All time" : filters.period} return
              </span>
            </header>
            <div className="fund-list-columns" aria-hidden="true">
              <span>Fund</span>
              <span>Return</span>
              <span>Assets</span>
            </div>
            <div className="fund-list">
              {funds.map((f) => (
                <FundRow
                  key={f.slug}
                  fund={f as (typeof REFERENCE_FUNDS)[number]}
                  period={filters.period}
                  returnTo={returnTo}
                />
              ))}
            </div>
          </section>
        ) : null;
      })}
    </main>
  );
}
