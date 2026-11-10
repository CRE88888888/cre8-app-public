import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  modelPositionGroups,
  positionWeightLabels,
  recentUpdateSources,
  recentFundSources,
  tradeUpdateDate,
} from "../../reference/lib/recent-trades";
import type { ModelTradeUpdate } from "../../reference/lib/recent-trades";
import {
  REFERENCE_METADATA,
  assetBySymbol,
  date,
} from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import { ReferenceSheet } from "./ReferenceSheet";
export function RecentTrades({ fund }: { fund: ReferenceFund }) {
  const [params, setParams] = useSearchParams();
  const updates = [...REFERENCE_METADATA[fund.slug].updates].sort((a, b) =>
      b.date.localeCompare(a.date),
    ),
    [open, setOpenState] = useState(
      params.get("trades") === "1" || params.has("update"),
    ),
    [selected, setSelectedState] = useState<ModelTradeUpdate | null>(
      () => updates.find((u) => u.id === params.get("update")) || null,
    ),
    [page, setPage] = useState(0),
    [filter, setFilter] = useState("all");
  const setOpen = (value: boolean) => {
    setOpenState(value);
    const next = new URLSearchParams(window.location.search);
    if (value) next.set("trades", "1");
    else {
      next.delete("trades");
      next.delete("update");
    }
    setParams(next, { replace: true });
  };
  const setSelected = (value: ModelTradeUpdate | null) => {
    setSelectedState(value);
    const next = new URLSearchParams(window.location.search);
    if (value) next.set("update", value.id);
    else next.delete("update");
    setParams(next, { replace: true });
  };
  const sources = (update: ModelTradeUpdate) =>
    fund.group === "stocks" || fund.group === "rwa" || fund.group === "crypto"
      ? []
      : recentUpdateSources(update, fund.group).length
        ? recentUpdateSources(update, fund.group)
        : recentFundSources(fund);
  const sourceLinks = (u: ModelTradeUpdate) => (
    <span className="trade-source-links">
      {sources(u).map((s) => (
        <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">
          {s.label} ↗
        </a>
      ))}
    </span>
  );
  const icons = (symbols: string[]) =>
    symbols.slice(0, 3).map((symbol) => {
      const asset = assetBySymbol(symbol);
      return asset?.logo ? (
        <img src={asset.logo} alt={asset.symbol} key={symbol} />
      ) : (
        <span key={symbol}>{symbol}</span>
      );
    });
  const timeline = (items: ModelTradeUpdate[]) => (
    <ol className="trade-update-timeline">
      {items.map((u, i) => (
        <li key={u.id} className={i === 0 ? "latest" : ""}>
          <button
            type="button"
            className="trade-update-link"
            onClick={() => {
              setSelected(u);
              setFilter("all");
              setOpen(true);
            }}
          >
            <time>{tradeUpdateDate(u.date).label}</time>
            <p>{u.summary}</p>
            <span className="trade-update-assets">
              {icons(u.assets)}
              {u.assets.length > 3 && (
                <small>+{u.assets.length - 3} more</small>
              )}
            </span>
            <span className="trade-update-chevron" aria-hidden="true">
              ›
            </span>
          </button>
          {sourceLinks(u)}
        </li>
      ))}
    </ol>
  );
  if (!updates.length) return null;
  const groups = selected ? modelPositionGroups(selected.positions) : null;
  const renderGroup = (key: keyof NonNullable<typeof groups>, title: string) =>
    !groups?.[key].length ? null : (
      <section className="trade-position-group" key={key}>
        <h3>{title}</h3>
        {groups[key].map((p) => {
          const asset = assetBySymbol(p.asset),
            labels = positionWeightLabels(p.beforePct, p.afterPct);
          return (
            <div className="trade-position-row" key={p.asset}>
              <Link
                to={
                  asset
                    ? `/asset/${asset.slug}?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`
                    : "#"
                }
                aria-disabled={!asset}
                onClick={(event) => {
                  if (!asset) event.preventDefault();
                }}
              >
                {asset?.logo && <img src={asset.logo} alt="" />}
                <strong>{asset?.symbol || p.asset}</strong>
              </Link>
              <span>
                {key === "unchanged" ? (
                  labels.after
                ) : (
                  <>
                    <small>{labels.before} → </small>
                    {labels.after}
                  </>
                )}
              </span>
            </div>
          );
        })}
      </section>
    );
  return (
    <section className="recent-trades">
      <header className="recent-trades-heading">
        <h2>Recent trades</h2>
      </header>
      <p className="recent-trades-note">
        {fund.sourceModel?.historyKind === "post-replay"
          ? "Public-post model updates. Source links included."
          : fund.sourceModel
            ? "Changes between reported holdings. Filing dates and sources included."
            : "Allocation updates from the historical model."}
      </p>
      {timeline(updates.slice(0, 2))}
      <button
        className="trade-updates-more"
        onClick={() => {
          setSelected(null);
          setPage(0);
          setOpen(true);
        }}
      >
        See more <span>›</span>
      </button>
      <p className="recent-trades-asof">Through {fund.backtest.through}</p>
      <ReferenceSheet
        open={open}
        onOpenChange={setOpen}
        title={selected ? "Trade update" : "Trade updates"}
      >
        {selected ? (
          <>
            <button
              className="trade-updates-back"
              onClick={() => setSelected(null)}
            >
              ← All updates
            </button>
            <time className="trade-detail-date">{date(selected.date)}</time>
            <p className="trade-detail-summary">{selected.summary}</p>
            {selected.asOf && (
              <p className="fine">
                Holdings as of {selected.asOf}
                {selected.published ? ` · Published ${selected.published}` : ""}
              </p>
            )}
            {selected.postedAt && (
              <p className="fine">Source posted {selected.postedAt}</p>
            )}
            {sourceLinks(selected)}
            <p className="recent-trades-note">
              Portfolio weights immediately before → after this update.{" "}
              {fund.sourceModel
                ? "Source holdings changes or model signals; not verified executions."
                : ""}
            </p>
            {renderGroup("new", "New positions")}
            {renderGroup("closed", "Closed positions")}
            {renderGroup("increased", "Increased positions")}
            {renderGroup("decreased", "Decreased positions")}
            {groups?.unchanged.length ? (
              <details>
                <summary>
                  Unchanged positions ({groups.unchanged.length})
                </summary>
                {renderGroup("unchanged", "Unchanged positions")}
              </details>
            ) : null}
            {selected.trades.length > 0 && (
              <details className="trade-ledger">
                <summary>Transaction log</summary>
                <div className="trade-filter">
                  {["all", "buy", "sell"].map((f) => (
                    <button
                      key={f}
                      aria-pressed={filter === f}
                      onClick={() => setFilter(f)}
                    >
                      {f === "all" ? "All" : f === "buy" ? "Buys" : "Sells"}
                    </button>
                  ))}
                </div>
                {selected.trades
                  .filter((t) => filter === "all" || t.side === filter)
                  .map((t) => (
                    <p key={t.id}>
                      {t.side === "buy" ? "Buy" : "Sell"} · {t.asset} ·{" "}
                      {t.navSharePct?.toFixed(2) ?? "—"}% of model NAV
                    </p>
                  ))}
              </details>
            )}
          </>
        ) : (
          <>
            {timeline(updates.slice(page * 12, page * 12 + 12))}
            <nav className="trade-pagination">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Previous
              </button>
              <span>
                {page + 1} / {Math.ceil(updates.length / 12)}
              </span>
              <button
                disabled={(page + 1) * 12 >= updates.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </nav>
          </>
        )}
      </ReferenceSheet>
    </section>
  );
}
