import payload from "../reference/data/funds.json";
import metadata from "../reference/data/fund-metadata.json";
import assetData from "../reference/data/asset-index.json";
import type { ExploreFund } from "../reference/lib/fund-explore";
import type { FundProfile } from "../reference/lib/fund-profile";
import type { ModelAllocationUpdate } from "../reference/lib/demo-fund-backtest";
import type { ModelTradeUpdate } from "../reference/lib/recent-trades";
import type { HoldingView } from "../reference/lib/fund-holdings";
import type { UnderlyingAsset } from "../reference/lib/underlying-assets";
import type { RiskFreeReference } from "../reference/lib/risk-free-rates";
import { fundEditorial } from "../reference/lib/fund-editorial";
export type ReferenceFund = Omit<ExploreFund, "backtest"> & {
  symbol: string;
  creator?: string;
  risk: "Low" | "Medium" | "High";
  sharePrice: number;
  fees?: { perf: number; mgmt: number; platform: number };
  manager: string;
  backtest: {
    start: string;
    through: string;
    basis: string;
    composition: string;
    rebalance: string;
    allocationUpdates?: ModelAllocationUpdate[];
    targets: {
      id: string;
      symbol: string;
      name: string;
      weight: number;
      logo?: string;
      source?: string;
    }[];
  };
  sourceModel?: {
    asOf: string;
    published: string;
    source: string;
    description: string;
    scope: string;
    notes: string[];
    historyBasis: string;
    historyKind: string;
    backtested: boolean;
    updates?: ModelTradeUpdate[];
  };
};
export type ReferenceMetadata = {
  cover: {
    src: string;
    thumbnailSrc: string;
    position: number;
    thumbnailPosition: number;
    /** `hedcut` = 白底點畫圖：版式是「圖靠右、名稱在左」，不是滿版照片。 */
    art?: "hedcut";
    /** 點畫圖畫的是人像（肩膀可以出血到下緣）還是物件（要完整留在框內）。 */
    subject?: "person" | "object";
  };
  profile: FundProfile | null;
  updates: ModelTradeUpdate[];
  holdings: HoldingView[];
};
export const REFERENCE_FUNDS = payload.funds as unknown as ReferenceFund[];
/**
 * 點畫封面（hedcut）：2026-11-13 起，30 檔參考基金的封面統一成同一種畫法 ——
 * 純白底、黑色墨點與線條（規格見 DESIGN.md「封面」）。圖在 `public/fund-covers/hedcut/`，
 * 每檔一張大圖（`<slug>.webp`）與一張縮圖（`<slug>-thumb.webp`）。
 *
 * 封面的來源資料（`src/reference/data/fund-metadata.json`）是同步來的不能改，
 * 所以在這裡覆蓋 `cover`：所有讀 `REFERENCE_METADATA[slug].cover` 的地方（列表頭像、
 * 基金頁封面、Portfolio 縮圖、交易抽屜）會一起換，不用各自處理。
 * 不在這份清單裡的基金（例如使用者自己建的）沒有圖，各處用名稱縮寫。
 */
export const HEDCUT_SLUGS: ReadonlySet<string> = new Set([
  "mag7",
  "ai-buildout",
  "multi-asset-balanced",
  "crypto-leaders",
  "treasury-reserve",
  "elon-universe",
  "pelosi-disclosed-equity",
  "berkshire-disclosed-equities",
  "trump-universe",
  "dan-bin-oriental-harbor",
  "ray-dalio-bridgewater",
  "bill-ackman-pershing",
  "bill-gates-foundation",
  "cathie-wood-arkk",
  "tom-lee-granny-shots",
  "dan-ives-ai",
  "stanley-druckenmiller-duquesne",
  "ken-griffin-citadel",
  "serenity-x",
  "raoul-pal-x",
  "ming-chi-kuo-x",
  "herman-jin-x",
  "chris-lee-x",
  "peter-schiff-euro-pacific",
  "jeffrey-gundlach-doubleline",
  "gavin-baker-atreides",
  "david-einhorn-dme",
  "jim-cramer-x",
  "lyn-alden-x",
  "leopold-aschenbrenner-situational",
]);
/** 畫的不是人像的那幾張（主題基金的物件，以及頭像本來就不是真人照片的 X 帳號）。 */
const HEDCUT_OBJECTS: ReadonlySet<string> = new Set([
  "mag7",
  "ai-buildout",
  "multi-asset-balanced",
  "crypto-leaders",
  "treasury-reserve",
  "serenity-x",
  "raoul-pal-x",
  "ming-chi-kuo-x",
]);
const hedcutCover = (slug: string): ReferenceMetadata["cover"] => ({
  src: `/fund-covers/hedcut/${slug}.webp`,
  thumbnailSrc: `/fund-covers/hedcut/${slug}-thumb.webp`,
  position: 50,
  thumbnailPosition: 50,
  art: "hedcut",
  subject: HEDCUT_OBJECTS.has(slug) ? "object" : "person",
});
export const REFERENCE_METADATA: Record<string, ReferenceMetadata> = Object.fromEntries(
  Object.entries(metadata as unknown as Record<string, ReferenceMetadata>).map(([slug, meta]) => [
    slug,
    HEDCUT_SLUGS.has(slug) ? { ...meta, cover: hedcutCover(slug) } : meta,
  ]),
);
export const REFERENCE_ASSETS = assetData as UnderlyingAsset[];
export let RISK_FREE: RiskFreeReference | null =
  payload.riskFree as RiskFreeReference;
export let HISTORY_THROUGH = payload.through;
export function updateReferenceMeta(
  through: string,
  riskFree: RiskFreeReference | null,
) {
  HISTORY_THROUGH = through;
  RISK_FREE = riskFree;
}
export const referenceFund = (slug: string) =>
  REFERENCE_FUNDS.find((f) => f.slug === slug);
export const editorial = (f: ReferenceFund) => fundEditorial(f);
export const assetBySymbol = (symbol: string) =>
  REFERENCE_ASSETS.find((a) => a.symbol === symbol) ||
  REFERENCE_ASSETS.find((a) => a.tokens.some((t) => t.symbol === symbol));
export const pct = (n: number | null | undefined) =>
  n == null
    ? "—"
    : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
export const date = (t: number | string) =>
  new Date(typeof t === "string" ? t + "T00:00:00Z" : t).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" },
  );
export const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: n < 1 ? 6 : 2,
      });
export const compact = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 2,
      });

// 報價與身分保留原始觀察日期；只有持有權重隨每日 NAV 更新。
const holdingTemplates = new Map(
  Object.values(REFERENCE_METADATA)
    .flatMap((meta) => meta.holdings)
    .map((row) => [row.symbol, row]),
);
export function referenceHoldings(
  positions: NonNullable<ReferenceFund["positions"]>,
) {
  return positions
    .filter((p) => p.w > 1e-10)
    .map((p) => {
      const symbol = p.p === "Idle" ? "USDT" : p.loc,
        template = holdingTemplates.get(symbol);
      if (template) return { ...template, weight: p.w };
      const asset = assetBySymbol(symbol),
        token = asset?.tokens.find((t) => t.symbol === symbol),
        last = asset?.history.at(-1);
      return {
        id: symbol,
        symbol,
        weight: p.w,
        chainId: 56,
        asset: asset?.symbol || symbol,
        identity: token
          ? {
              symbol,
              ticker: asset!.symbol,
              address: token.address,
              issuer: token.issuer,
              chainId: token.chainId,
              marketKey: asset!.slug.replace("-", ":"),
            }
          : null,
        quote: null,
        marketCap: null,
        size: asset?.size ?? null,
        sizeKind: asset?.kind === "etf" ? "aum" : null,
        change24h: null,
        preview: asset
          ? {
              slug: asset.slug,
              name: asset.name,
              ticker: asset.symbol,
              logo: asset.logo,
              price: last?.v ?? null,
              currency: asset.historyCurrency,
              priceAsOf: asset.historyThrough,
              priceBasis: asset.historyBasis,
              change: null,
              changeLabel: "",
              size: asset.size,
              sizeLabel: asset.sizeKind,
              sizeAsOf: asset.sizeAsOf,
              series: asset.history.slice(-30),
              historyThrough: asset.historyThrough,
              historyBasis: asset.historyBasis,
              historyCurrency: asset.historyCurrency,
            }
          : null,
      } as HoldingView;
    });
}
