import type { ReactNode } from "react";
import { RollingNumber } from "../../components/RollingNumber";
import { Link } from "react-router-dom";
import {
  chartGeometry,
  collectionOf,
  currentFundAssets,
  periodMetrics,
  periodSeries,
} from "../../reference/lib/fund-explore";
import type { Period } from "../../reference/lib/fund-explore";
import { REFERENCE_METADATA, assetBySymbol, pct } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";

/**
 * Funds 頁的「主打卡」與「排行榜列」。
 *
 * 設計原則（2026-11-13 改版，見 DESIGN.md）：
 *   - 主角是數字與持倉，不是照片 —— 封面縮成頭像（人物圓形、主題方形）。
 *   - 桌面與手機是同一種列表，只是手機收掉持倉與回撤欄。
 *   - 整列是一個連結，裡面不再放第二層可點的東西（原本的人物浮層留在基金詳情頁）。
 */

const KIND = { themes: "Theme", "public-figures": "Public figure", "x-voices": "X voice" } as const;

/** 顯示用代號：`NVDAB`、`SGOVon` 這類鏈上代幣符號換回底層 ticker；查不到就原樣顯示。 */
const ticker = (symbol: string) => assetBySymbol(symbol)?.symbol ?? symbol;

type Holding = { symbol: string; label: string; weight: number; logo: string | null };

/** 目前模型持倉，由大到小；權重正規化成合計 100，避免殘餘現金讓比例條留白。 */
export function fundHoldings(fund: ReferenceFund): Holding[] {
  const assets = currentFundAssets(fund);
  const total = assets.reduce((sum, asset) => sum + asset.weight, 0);
  if (!(total > 0)) return [];
  return assets.map(({ symbol, weight, logo }) => ({
    symbol,
    label: ticker(symbol),
    weight: (weight / total) * 100,
    logo: assetBySymbol(symbol)?.logo || (logo ? `/logos/${logo}` : null),
  }));
}

const whole = (weight: number) => `${Math.round(weight)}%`;

/** 「名稱 · 機構」的機構那一段；沒有就回 null。 */
function nameParts(name: string) {
  const split = name.indexOf(" · ");
  return split < 0 ? { title: name, org: null } : { title: name.slice(0, split), org: name.slice(split + 3) };
}

/** 一句話說明這檔是什麼：類型，加上機構或 X 帳號（有的話）。 */
function describe(fund: ReferenceFund): string {
  const kind = KIND[collectionOf(fund)];
  const { org } = nameParts(fund.name);
  if (org) return `${kind} · ${org}`;
  if (fund.group === "x-voices" && fund.xHandle) return `${kind} · @${fund.xHandle}`;
  return kind;
}

export function FundAvatar({ fund }: { fund: ReferenceFund }): ReactNode {
  const meta = REFERENCE_METADATA[fund.slug] as (typeof REFERENCE_METADATA)[string] | undefined;
  const person = fund.group === "people" || fund.group === "x-voices";
  if (meta === undefined) {
    // 社群策略沒有封面：用名稱縮寫，不放假的圖。
    const initials = fund.name.replace(/[^A-Za-z0-9一-鿿]/g, "").slice(0, 2).toUpperCase() || "C8";
    return <span className="mkt-avatar mkt-avatar--initials" aria-hidden="true">{initials}</span>;
  }
  return (
    <span className={`mkt-avatar${person ? " mkt-avatar--person" : ""}`} aria-hidden="true">
      <img src={meta.cover.thumbnailSrc} alt="" width="48" height="48" loading="lazy"
        style={{ objectPosition: `50% ${person ? 22 : meta.cover.thumbnailPosition}%` }} />
    </span>
  );
}

/** 持倉比例條：前四大各一段，其餘合成最後一段。純裝飾，數字另外用文字寫出。 */
export function AllocationBar({ holdings }: { holdings: readonly Holding[] }): ReactNode {
  if (holdings.length === 0) return null;
  const head = holdings.slice(0, 4);
  const rest = holdings.slice(4).reduce((sum, row) => sum + row.weight, 0);
  return (
    <span className="mkt-bar" aria-hidden="true">
      {head.map((row) => <i key={row.symbol} style={{ flexGrow: row.weight }} />)}
      {rest > 0.5 && <i className="mkt-bar-rest" style={{ flexGrow: rest }} />}
    </span>
  );
}

function Trend({ fund, period, width, height, area = false }: {
  fund: ReferenceFund; period: Period; width: number; height: number; area?: boolean;
}): ReactNode {
  const chart = chartGeometry(periodSeries(fund, period), width, height);
  if (!chart) return null;
  return (
    <svg className="mkt-trend" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {area && <path className="mkt-trend-area" d={`${chart.path} L${width - 4},${height} L4,${height} Z`} />}
      <path className="mkt-trend-line" d={chart.path} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const toneOf = (value: number | null) => (value === null ? "" : value >= 0 ? "pos" : "neg");

/**
 * 1Y 是用 NAV 序列算的；歷史比別人短的基金（多半是 X voices）報酬只涵蓋實際天數。
 * 把天數寫出來，免得半年的數字被當成一年的來比。`fullDays` 是榜上最長的歷史：
 * 差不到一個月就不標，否則每一列都會多一行一樣的字。
 */
function partialNote(fund: ReferenceFund, period: Period, fullDays: number): string | null {
  const metrics = periodMetrics(fund, period);
  return metrics.partial && metrics.days > 0 && metrics.days < fullDays - 30
    ? `${Math.round(metrics.days)}d history`
    : null;
}

/** 這個期間裡，清單上最長的歷史天數（給 `partialNote` 當基準）。 */
export function longestHistory(funds: readonly ReferenceFund[], period: Period): number {
  return funds.reduce((longest, fund) => Math.max(longest, periodMetrics(fund, period).days), 0);
}

export function FeaturedCard({ fund, period, url, rank, fullDays }: {
  fund: ReferenceFund; period: Period; url: string; rank: number; fullDays: number;
}): ReactNode {
  const metrics = periodMetrics(fund, period);
  const holdings = fundHoldings(fund);
  const tone = toneOf(metrics.returnPct);
  const note = partialNote(fund, period, fullDays);
  return (
    <li className="mkt-feature">
      <Link to={url} className="mkt-feature-link" viewTransition>
        <span className="mkt-feature-head">
          <span className="mkt-rank" aria-label={`Rank ${rank}`}>{String(rank).padStart(2, "0")}</span>
          <FundAvatar fund={fund} />
          <span className="mkt-id">
            <strong>{nameParts(fund.name).title}</strong>
            <small>{describe(fund)}</small>
          </span>
        </span>
        <span className="mkt-feature-figure">
          <RollingNumber key={`${period}:${pct(metrics.returnPct)}`} className={`mkt-feature-return ${tone}`} value={pct(metrics.returnPct)} />
          {note && <small>{note}</small>}
        </span>
        <span className={`mkt-feature-trend ${tone}`}>
          <Trend fund={fund} period={period} width={320} height={84} area />
        </span>
        <span className="mkt-feature-holdings">
          <AllocationBar holdings={holdings} />
          <span className="mkt-chips">
            {holdings.slice(0, 3).map((row) => (
              <span key={row.symbol} className="mkt-chip">
                {row.logo && <img src={row.logo} alt="" width="16" height="16" loading="lazy" />}
                {row.label} <b>{whole(row.weight)}</b>
              </span>
            ))}
            {holdings.length > 3 && <span className="mkt-chip mkt-chip--more">+{holdings.length - 3}</span>}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function BoardRow({ fund, period, url, rank, meta, fullDays }: {
  fund: ReferenceFund;
  period: Period;
  url: string;
  /** 榜上最長的歷史天數；社群策略不標歷史長度，可省略。 */
  fullDays?: number;
  /** 排名；社群策略的走勢不是實績，不參與排名，傳 null。 */
  rank: number | null;
  /** 取代預設說明行（社群策略顯示「建立者 · 鏈上 id」）。 */
  meta?: ReactNode;
}): ReactNode {
  const metrics = periodMetrics(fund, period);
  const holdings = fundHoldings(fund);
  const tone = toneOf(metrics.returnPct);
  const note = fullDays === undefined ? null : partialNote(fund, period, fullDays);
  const { title } = nameParts(fund.name);
  return (
    <li className="mkt-row" data-slug={fund.slug}>
      <Link to={url} className="mkt-row-link" viewTransition>
        <span className="mkt-row-rank">{rank ?? "–"}</span>
        <span className="mkt-row-fund">
          <FundAvatar fund={fund} />
          <span className="mkt-id">
            <strong>{title}</strong>
            <small>{meta ?? describe(fund)}</small>
          </span>
        </span>
        <span className="mkt-row-holdings">
          <AllocationBar holdings={holdings} />
          <small>
            {holdings.length === 0
              ? "Allocation loading"
              : holdings.slice(0, 3).map((row) => `${row.label} ${whole(row.weight)}`).join(" · ") +
                (holdings.length > 3 ? ` · +${holdings.length - 3}` : "")}
          </small>
        </span>
        <span className={`mkt-row-trend ${tone}`}>
          <Trend fund={fund} period={period} width={120} height={36} />
        </span>
        <span className="mkt-row-return">
          <strong className={tone}>{pct(metrics.returnPct)}</strong>
          {note && <small>{note}</small>}
        </span>
        <span className="mkt-row-dd">{pct(metrics.maxDrawdown)}</span>
      </Link>
    </li>
  );
}
