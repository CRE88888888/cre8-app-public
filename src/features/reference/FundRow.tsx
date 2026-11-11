import { Link } from "react-router-dom";
import {
  periodMetrics,
  periodLabel,
  currentFundAssets,
} from "../../reference/lib/fund-explore";
import type { Period } from "../../reference/lib/fund-explore";
import { assetBySymbol, pct } from "../../lib/public-funds";
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
    assets = currentFundAssets(fund);
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
            {metrics.partial && fund.nav?.[0]
              ? "Since " +
                new Intl.DateTimeFormat("en-US", {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                }).format(fund.nav[0].t)
              : periodLabel(fund, period)}
          </small>
        </span>
        <span
          className="fund-asset-icons"
          aria-label={assets.map((a) => a.symbol).join(", ")}
        >
          {assets.slice(0, 3).map(({ symbol, logo }) => {
            const asset = assetBySymbol(symbol);
            const image = asset?.logo || (logo ? `/logos/${logo}` : null);
            return (
              <Link
                key={symbol}
                to={
                  asset
                    ? `/asset/${asset.slug}?returnTo=${encodeURIComponent(returnTo)}`
                    : url
                }
                title={asset?.name || symbol}
              >
                {image ? (
                  <img src={image} alt={symbol} />
                ) : (
                  <span>{symbol}</span>
                )}
              </Link>
            );
          })}
          {assets.length > 3 && (
            <span className="fund-assets-more">+{assets.length - 3}</span>
          )}
        </span>
      </div>
    </article>
  );
}
