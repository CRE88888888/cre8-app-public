import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useBodyClass } from "../../lib/use-body-class";
import { REFERENCE_FUNDS } from "../../lib/public-funds";
import { selectFunds } from "../../reference/lib/fund-explore";
import { performancePeriod } from "../../reference/lib/fund-navigation";
import { FundRow } from "./FundRow";
export function CreatorPage() {
  useBodyClass("fund-explore", "atp-formal-market", "atp-complete-market");
  const { id } = useParams(),
    [params, setParams] = useSearchParams(),
    location = useLocation(),
    period = performancePeriod(params.get("period"));
  const valid =
    id === "cre8" ||
    REFERENCE_FUNDS.some((f) => f.creator?.toLowerCase() === id?.toLowerCase());
  if (!valid)
    return (
      <main className="page">
        <h1>Creator not found</h1>
        <Link to="/vaults">All funds</Link>
      </main>
    );
  return (
    <main className="explore-wrap" id="fund-explore">
      <Link className="vault-back" to="/vaults">
        ← All funds
      </Link>
      <header className="explore-heading">
        <div>
          <h1>
            CRE8<span>.</span>
          </h1>
          <p>
            Explore CRE8’s public reference portfolios across market themes,
            public figures and X voices.
          </p>
        </div>
      </header>
      <label className="public-history-note">
        Period{" "}
        <select
          value={period}
          onChange={(event) =>
            setParams({ period: event.target.value }, { replace: true })
          }
        >
          {["7D", "30D", "90D", "1Y", "ALL"].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
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
