import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { longestWordLength } from "../../lib/cover-title";
import { AppIcon } from "../../components/AppIcon";
import { toast } from "../../components/Toast";
import { ReferenceSheet } from "./ReferenceSheet";
import { Link, useSearchParams } from "react-router-dom";
import { REFERENCE_METADATA, assetBySymbol, editorial } from "../../lib/public-funds";
import type { FundArt } from "../../lib/fund-art";
import { artStyle } from "../vaults/FundTile";
import { describeFundLaunch, fundLaunchStatus } from "../../lib/launch-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import { performancePeriod } from "../../reference/lib/fund-navigation";
import { Performance } from "./Performance";
import { RecentTrades } from "./RecentTrades";
import { Assets } from "./Assets";
import { FundIntroduction, FundName } from "./Profile";
export function FundOverview({
  fund,
  backTo,
  onFacts,
  factsTrigger,
  onPosition,
  held,
  art = null,
  notices = [],
  modelNote = null,
  launchCopy,
  hideModelTrades = false,
}: {
  fund: ReferenceFund;
  /** 新版首頁同一組封面（`lib/fund-art.ts`）；有的話優先用它。 */
  art?: FundArt | null;
  /** 封面下方的提醒（已下架、槓桿高風險），每則一句。 */
  notices?: readonly { id: string; text: string }[];
  /** 模型報酬區下方的一行小字：哪些成分較晚或還沒計入回測（`inclusionNote`）。 */
  modelNote?: string | null;
  /** 首發基金的英文說明（`lib/fund-copy.ts`）；有的話取代目錄或後端的說明。 */
  launchCopy?: { description: string; method: string };
  /** 不顯示「Recent trades」：那是目錄舊回測的調整紀錄，不是這檔基金實際的交易（C3 2026-11-20）。 */
  hideModelTrades?: boolean;
  backTo: string;
  onFacts: () => void;
  factsTrigger: Ref<HTMLButtonElement>;
  onPosition: () => void;
  held: boolean;
}) {
  const [params, setParams] = useSearchParams(),
    period = performancePeriod(params.get("period")),
    // Community 策略（`/funds/strategy/:id`）沒有參考目錄的封面與人物資料，meta 會是 undefined。
    meta = REFERENCE_METADATA[fund.slug] as (typeof REFERENCE_METADATA)[string] | undefined,
    base = editorial(fund),
    copy = launchCopy ? { ...base, paragraphs: [launchCopy.description], methodology: [launchCopy.description, launchCopy.method] } : base;
  const fromPortfolio = /^\/portfolios?(?:[?#]|$)/.test(backTo);
  // 上線時這檔能不能投資（cre8-app#51）。社群策略不是展示基金，回 null、不顯示。
  const launch = fundLaunchStatus(fund.slug);
  const [shareLink, setShareLink] = useState<string | null>(null);
  async function shareFund() {
    const url = new URL(`/funds/${fund.slug}`, window.location.origin);
    if (params.has("period")) url.searchParams.set("period", period);
    try {
      if (navigator.share) {
        await navigator.share({ title: fund.name, url: url.href });
        return;
      }
      await navigator.clipboard.writeText(url.href);
      toast.ok("Fund link copied");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareLink(url.href);
    }
  }

  // 封面名稱的字級依最長的字縮放（styles/covers.css 的 --title-word），名稱才不會壓到人像。
  const coverTitle = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const title = coverTitle.current;
    if (title !== null) title.style.setProperty("--title-word", String(longestWordLength(title.textContent ?? "")));
  }, [fund.slug]);
  return (
    <>
      <div className="vault-top">
        <header className="vhead">
          <Link className="vault-back" to={backTo} viewTransition>
            <AppIcon name="left" size={16} /> {fromPortfolio ? "Profile" : "All funds"}
          </Link>
          <div className="vault-heading">
            <div className={`atp-fund-cover${art || meta === undefined ? " is-plate" : meta.cover.art === "hedcut" ? ` is-hedcut is-${meta.cover.subject ?? "person"}` : meta.cover.art === "photo" ? " is-photo" : ""}${art?.srcDark ? " is-person" : ""}`} id="atp-fund-cover" data-fund-cover>
              {art ? (
                // 首頁的版畫：色板＋遮罩，顏色跟主題走。
                <span className="lp-cover-ink" aria-hidden="true" data-entry="fund-art" style={artStyle(art)} />
              ) : meta === undefined ? (
                // 還沒有封面的基金：只有色板（中性，使用者 2026-11-20），封面等之後補。
                null
              ) : (
                <img
                  src={meta.cover.src}
                  alt=""
                  fetchPriority="high"
                  // 寫實照的人物在右 60%：封面被擠成直的時（桌機窄主欄）要往右對齊，才不會切到人（styles/covers.css）。
                  style={{ objectPosition: `${meta.cover.art === "photo" ? 72 : 50}% ${meta.cover.position}%` }}
                />
              )}
              <div className="atp-fund-cover-shade" />
              <nav className="app-fund-toolbar" aria-label="Fund navigation">
                <Link to={backTo} aria-label={fromPortfolio ? "Back to portfolio" : "Back to funds"}>
                  <AppIcon name="left" size={21} />
                </Link>
                <button type="button" aria-label="Share fund" onClick={() => void shareFund()}>
                  <AppIcon name="share" size={21} />
                </button>
              </nav>
              <h1 ref={coverTitle}>
                <FundName fund={fund} />
              </h1>
            </div>
            <div className="atp-fund-byline">
              <FundIntroduction fund={fund} />
              <div className="vault-head-actions">
                <button
                  ref={factsTrigger}
                  type="button"
                  className="btn ghost sm atp-facts-trigger"
                  aria-haspopup="dialog"
                  onClick={onFacts}
                >
                  Fund facts
                </button>
                {held && (
                  <button className="btn ghost sm app-position-trigger" onClick={onPosition}>
                    My position
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* 封面下方獨立一行：byline 在點畫封面上是疊在圖上的，放不下一整句說明。 */}
          {launch && (
            <p className="fund-launch" data-status={launch.status}>
              <span className="fund-launch-dot" aria-hidden="true" />
              {describeFundLaunch(launch, (symbol) => assetBySymbol(symbol)?.symbol ?? symbol)}
            </p>
          )}
          {notices.map((notice) => (
            <p key={notice.id} className="fine warn fund-notice" role="note" data-entry={notice.id}>{notice.text}</p>
          ))}
        </header>
      </div>
      <ReferenceSheet
        open={shareLink !== null}
        onOpenChange={(open) => {
          if (!open) setShareLink(null);
        }}
        title="Share fund"
      >
        <label className="field">
          Fund link
          <input
            type="url"
            value={shareLink ?? ""}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      </ReferenceSheet>
      <Performance
        fund={fund}
        period={period}
        onChange={(p) => {
          const next = new URLSearchParams(params);
          next.set("period", p);
          setParams(next, { replace: true });
        }}
      />
      {modelNote && <p className="fine" data-entry="model-inclusion">{modelNote}</p>}
      <section className="vault-about vault-description">
        <h2>Description</h2>
        {copy.paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        <details className="vault-details">
          <summary><AppIcon name="document" size={17} /> Sources &amp; methodology</summary>
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
              Primary source <AppIcon name="external" size={14} />
            </a>
          )}
        </details>
      </section>
      {!hideModelTrades && <RecentTrades fund={fund} />}
      <Assets fund={fund} />
      <section className="vault-about vault-disclaimer">
        {/* 使用者 2026-11-17：提示太吵。免責聲明收起來，點開才看。 */}
        <details className="vault-details">
          <summary>Disclaimer</summary>
          <p>{copy.disclaimer}</p>
        </details>
        <details className="vault-details public-cover-credits">
          <summary>Cover image credits</summary>
          <p>
            Stipple illustrations generated with AI from public identity
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
