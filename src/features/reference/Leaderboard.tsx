import { useSearchParams, useLocation } from "react-router-dom";
import { useBodyClass } from "../../lib/use-body-class";
import { REFERENCE_FUNDS } from "../../lib/public-funds";
import { performancePeriod } from "../../reference/lib/fund-navigation";
import { selectFunds } from "../../reference/lib/fund-explore";
import { FundRow } from "./FundRow";
export function Leaderboard() {
  useBodyClass("fund-explore", "atp-formal-market", "atp-complete-market");
  const [params, setParams] = useSearchParams(),
    location = useLocation(),
    period = performancePeriod(params.get("period"));
  return (
    <main className="explore-wrap" id="fund-explore">
      <header className="explore-heading">
        <h1>
          Leaderboard<span>.</span>
        </h1>
      </header>
      <p className="public-history-note">
        Historical reference models, ranked by return over the selected period.
        Before fees.
      </p>
      <div className="seg public-periods">
        {["7D", "30D", "90D", "1Y", "ALL"].map((p) => (
          <button
            key={p}
            aria-pressed={period === p}
            className={period === p ? "on" : ""}
            onClick={() => setParams({ period: p }, { replace: true })}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="fund-list">
        {selectFunds(REFERENCE_FUNDS, "", "all", "perf", period).map((f) => (
          <FundRow
            key={f.slug}
            fund={f as (typeof REFERENCE_FUNDS)[number]}
            period={period}
            returnTo={location.pathname + location.search}
          />
        ))}
      </div>
    </main>
  );
}
