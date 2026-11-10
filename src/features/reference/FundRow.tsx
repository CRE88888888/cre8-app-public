import { Link } from "react-router-dom";
import {
  periodMetrics,
  periodLabel,
  chartGeometry,
  periodSeries,
} from "../../reference/lib/fund-explore";
import type { Period } from "../../reference/lib/fund-explore";
import { REFERENCE_METADATA, pct } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import { FundByline, FundPortrait, FundName } from "./Profile";
export function FundRow({
  fund,
  period,
  returnTo,
}: {
  fund: ReferenceFund;
  period: Period;
  returnTo: string;
}) {
  const metrics = periodMetrics(fund, period),
    assets = REFERENCE_METADATA[fund.slug].holdings.filter(
      (a) => a.weight != null && a.weight > 0,
    ),
    graph = chartGeometry(periodSeries(fund, period), 120, 36);
  const url = `/funds/${fund.slug}?period=${period}&returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <article className="fund-row" data-slug={fund.slug}>
      <div className="fund-row-link">
        <FundPortrait fund={fund} url={url} />
        <div className="fund-list-body">
          <h3>
            <FundName fund={fund} url={url} />
          </h3>
          <FundByline fund={fund} />
        </div>
        <span className="fund-list-result">
          <strong className={(metrics.returnPct ?? 0) >= 0 ? "pos" : "neg"}>
            {pct(metrics.returnPct)}
          </strong>
          <small>
            {periodLabel(fund, period)}
            {metrics.partial && fund.nav?.[0]
              ? ` · ${new Date(fund.nav[0].t).toISOString().slice(0, 10)}`
              : ""}
          </small>
          {graph && (
            <svg viewBox="0 0 120 36" aria-hidden="true">
              <path
                d={graph.path}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          )}
        </span>
        <span
          className="fund-asset-icons"
          aria-label={assets.map((a) => a.asset).join(", ")}
        >
          {assets.slice(0, 3).map((a) => (
            <Link
              key={a.id}
              to={
                a.preview
                  ? `/asset/${a.preview.slug}?returnTo=${encodeURIComponent(returnTo)}`
                  : url
              }
              title={a.preview?.name || a.asset}
            >
              {a.preview?.logo && <img src={a.preview.logo} alt={a.asset} />}
            </Link>
          ))}
          {assets.length > 3 && (
            <span className="fund-assets-more">+{assets.length - 3}</span>
          )}
        </span>
      </div>
    </article>
  );
}
