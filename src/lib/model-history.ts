/**
 * 後端的模型報酬（backend#174、#175）：
 * - 列表 `GET /strategies` 每檔的 `modelReturns`：{ asOf, d7, d30, d90, y1, all, annualized } 或 null。
 *   報酬是百分比的十進位字串（8 位小數），算不出來的期間是 null。`annualized` 是後端用模型淨值頭尾、依實際天數複利年化
 *   的推估 APY（歷史不夠就是 null）。
 * - 詳情 `GET /strategies/:id` 另外有 `modelNav: [{ date, value }]`，由舊到新、最多兩年，沒有就是 []。
 *
 * 使用者 2026-11-20：卡片只放推估年化 APY；基金頁的走勢與期間報酬都用後端這份，App 內建的舊回測不再使用。
 */
import { periodSeries, type Period } from '../reference/lib/fund-explore';
import { assetBySymbol, type ReferenceFund } from './public-funds';

export type ModelReturns = {
  asOf: string;
  d7: string | null;
  d30: string | null;
  d90: string | null;
  y1: string | null;
  all: string | null;
  annualized: string | null;
};

export type NavPoint = { t: number; v: number };

/** 十進位字串（或數字）→ 百分比數字；null、空字串、算不出來回 null。 */
export function parsePct(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 卡片上的推估年化 APY；沒有就是 null（畫面顯示「—」）。 */
export function annualizedOf(returns: ModelReturns | null | undefined): { apy: number; asOf: string } | null {
  const apy = parsePct(returns?.annualized);
  return apy === null || !returns ? null : { apy, asOf: returns.asOf };
}

/** 後端 `modelNav: [{ date, value }]`（value 是字串）換成 {t, v}；格式不對的點略過，依時間排序。 */
export function navFromApi(modelNav: unknown): NavPoint[] {
  if (!Array.isArray(modelNav)) return [];
  return modelNav
    .map((point) => ({ t: Date.parse(String((point as { date?: unknown })?.date)), v: Number((point as { value?: unknown })?.value) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v) && point.v > 0)
    .sort((a, b) => a.t - b.t);
}

const PERIODS: readonly Period[] = ['7D', '30D', '90D', '1Y', 'ALL'];

/** 一段淨值的最大回撤（百分比，≤ 0）；少於兩點回 null。 */
function maxDrawdownOf(series: readonly NavPoint[]): number | null {
  if (series.length < 2) return null;
  let peak = series[0]!.v, worst = 0;
  for (const point of series) {
    peak = Math.max(peak, point.v);
    worst = Math.min(worst, (point.v / peak - 1) * 100);
  }
  return worst;
}

/**
 * 把基金的走勢與期間數字換成後端的模型資料。目錄基金（Mag7）也一樣換掉，不再用 App 內建的舊回測；
 * 後端沒有資料時就是空的（畫面顯示「—」與「資料不足」）。
 */
export function withModelHistory(fund: ReferenceFund, detail: { modelNav?: unknown; modelReturns?: ModelReturns | null }): ReferenceFund {
  const nav = navFromApi(detail.modelNav);
  const r = detail.modelReturns ?? null;
  const returns: Record<Period, number | null> = {
    '7D': parsePct(r?.d7),
    '30D': parsePct(r?.d30),
    '90D': parsePct(r?.d90),
    '1Y': parsePct(r?.y1),
    ALL: parsePct(r?.all),
  };
  const maxDrawdown = Object.fromEntries(PERIODS.map((period) => [period, maxDrawdownOf(periodSeries({ nav }, period))])) as Record<Period, number | null>;
  return { ...fund, nav, returns, maxDrawdown } as ReferenceFund;
}

/** 詳情的 `modelComponents`（backend#177）：每個成分從哪天起計入回測；null＝還沒計入（例如尚未上市）。 */
export type ModelComponent = { symbol: string; includedFrom: string | null };

/** 還沒上市、資料裡查不到公司名的成分，用短名稱。 */
const SHORT_NAMES: Record<string, string> = { SPCXB: 'SpaceX', ANTB: 'Anthropic' };

function componentName(symbol: string): string {
  return SHORT_NAMES[symbol] ?? assetBySymbol(symbol)?.symbol ?? symbol;
}

/**
 * 基金頁模型報酬區的一行小字（C3 2026-11-20）：成分比回測第一天晚才計入，或還沒計入時說明。
 * 例：「SpaceX is included in the backtest from 2026-07-12; Anthropic is not included yet.」都從第一天就計入就回 null。
 */
export function inclusionNote(components: unknown, modelNav: unknown): string | null {
  if (!Array.isArray(components)) return null;
  const start = navFromApi(modelNav)[0]?.t;
  const parts: string[] = [];
  for (const item of components as ModelComponent[]) {
    if (typeof item?.symbol !== 'string') continue;
    if (item.includedFrom === null || item.includedFrom === undefined) {
      parts.push(`${componentName(item.symbol)} is not included yet`);
      continue;
    }
    const from = Date.parse(item.includedFrom);
    if (Number.isFinite(from) && (start === undefined || from > start)) parts.push(`${componentName(item.symbol)} is included in the backtest from ${item.includedFrom}`);
  }
  return parts.length === 0 ? null : `${parts.join('; ')}.`;
}
