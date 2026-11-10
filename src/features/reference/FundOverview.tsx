import { Link, useSearchParams } from "react-router-dom";
import { REFERENCE_METADATA, editorial } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import { performancePeriod } from "../../reference/lib/fund-navigation";
import { Performance } from "./Performance";
import { RecentTrades } from "./RecentTrades";
import { Assets } from "./Assets";
import { FundByline, FundName } from "./Profile";
export function FundOverview({
  fund,
  backTo,
  onFacts,
  onPosition,
  held,
}: {
  fund: ReferenceFund;
  backTo: string;
  onFacts: () => void;
  onPosition: () => void;
  held: boolean;
}) {
  const [params, setParams] = useSearchParams(),
    period = performancePeriod(params.get("period")),
    meta = REFERENCE_METADATA[fund.slug],
    copy = editorial(fund);
  return (
    <>
      <div className="vault-top">
        <header className="vhead">
          <Link className="vault-back" to={backTo}>
            ← All funds
          </Link>
          <div className="vault-heading">
            <div className="atp-fund-cover" id="atp-fund-cover" data-fund-cover>
              <img
                src={meta.cover.src}
                alt=""
                fetchPriority="high"
                style={{ objectPosition: `50% ${meta.cover.position}%` }}
              />
              <div className="atp-fund-cover-shade" />
              <h1>
                <FundName fund={fund} />
              </h1>
            </div>
            <div className="atp-fund-byline">
              <span className="vault-manager">
                <small>by</small>
                <FundByline fund={fund} />
              </span>
              <div className="vault-head-actions">
                <button className="atp-facts-trigger" onClick={onFacts}>
                  Fund facts ›
                </button>
                {held && (
                  <button className="btn ghost sm" onClick={onPosition}>
                    My position
                  </button>
                )}
              </div>
            </div>
          </div>
        </header>
      </div>
      <Performance
        fund={fund}
        period={period}
        onChange={(p) => {
          const next = new URLSearchParams(params);
          next.set("period", p);
          setParams(next, { replace: true });
        }}
      />
      <section className="vault-about vault-description">
        <h2>Description</h2>
        {copy.paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        <details className="vault-details">
          <summary>Sources &amp; methodology</summary>
          {copy.methodology.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          <p>{fund.backtest.basis}</p>
          {fund.sourceModel && (
            <a
              href={fund.sourceModel.source}
              target="_blank"
              rel="noopener noreferrer"
            >
              Primary source ↗
            </a>
          )}
        </details>
      </section>
      <RecentTrades fund={fund} />
      <Assets fund={fund} />
      <section className="vault-about vault-disclaimer">
        <h2>Disclaimer</h2>
        <p>{copy.disclaimer}</p>
        <details className="vault-details public-cover-credits">
          <summary>Cover image credits</summary>
          <p>
            AI-generated editorial illustrations based on public identity
            references. Public figures identify portfolio themes; the publisher
            is CRE8.
          </p>
          {fund.slug === "elon-universe" && (
            <p>
              Elon Musk identity reference:{" "}
              <a
                href="https://commons.wikimedia.org/wiki/File:Elon_Musk_Royal_Society_(crop1).jpg"
                target="_blank"
                rel="noopener noreferrer"
              >
                Duncan Hull
              </a>
              ,{" "}
              <a
                href="https://creativecommons.org/licenses/by-sa/4.0/"
                target="_blank"
                rel="noopener noreferrer"
              >
                CC BY-SA 4.0
              </a>
              . Generated portrait adaptation, shared under the same license.
            </p>
          )}
        </details>
      </section>
    </>
  );
}
