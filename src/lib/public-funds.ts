import payload from "../reference/data/funds.json";
import { listedFunds, TESTNET_LISTED_SLUGS } from "./testnet-catalogue";
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
    /**
     * `hedcut` = 白底點畫圖：版式是「圖靠右、名稱在左」，不是滿版照片。
     * `photo` = 深綠寫實照（2026-11-18）：滿版、人物在右 60%、左邊留給名稱，不加漸層。
     */
    art?: "hedcut" | "photo";
    /** 點畫圖畫的是人像（肩膀可以出血到下緣）還是物件（要完整留在框內）。 */
    subject?: "person" | "object";
  };
  profile: FundProfile | null;
  updates: ModelTradeUpdate[];
  holdings: HoldingView[];
};
export const REFERENCE_FUNDS = payload.funds as unknown as ReferenceFund[];
/**
 * 畫面上要列出來的基金：主網與測試網都只列 16 檔（cre8-app#86、#123，見 `testnet-catalogue.ts`）。
 * 與 `REFERENCE_FUNDS` 是同一批物件：參考資料更新時就地改寫，這裡跟著變。
 * `REFERENCE_FUNDS` 仍是同步來的全部 30 檔，只給參考資料更新比對用；畫面一律用這份。
 */
export const LISTED_FUNDS: ReferenceFund[] = listedFunds(REFERENCE_FUNDS);
/**
 * 寫實照封面（2026-11-18）：深綠底、金色側光、穿西裝風衣戴墨鏡的主角，牆上刻公司名。
 * 圖在 `public/fund-covers/photo/`：大圖 `<slug>.webp`（3:2）與方形縮圖 `<slug>-thumb.webp`（已裁好臉）。
 * 列出的 16 檔都有（見 `testnet-catalogue.ts`）。原本其餘基金用的點畫封面（hedcut）隨那 14 檔一起拿掉（cre8-app#123）。
 */
export const PHOTO_COVER_SLUGS: ReadonlySet<string> = new Set(TESTNET_LISTED_SLUGS);
/** 主題基金拍的是物件（Mag7 是七位 CEO 的合照，也算主題）。 */
const PHOTO_OBJECTS: ReadonlySet<string> = new Set(["mag7", "ai-buildout", "multi-asset-balanced", "treasury-reserve"]);
const photoCover = (slug: string): ReferenceMetadata["cover"] => ({
  src: `/fund-covers/photo/${slug}.webp`,
  thumbnailSrc: `/fund-covers/photo/${slug}-thumb.webp`,
  // 桌機封面約 3.2:1，只露出圖的中間一半：人像往上對齊，才看得到牆上的字與整顆頭；物件置中。
  position: slug === "mag7" ? 35 : PHOTO_OBJECTS.has(slug) ? 50 : 22,
  thumbnailPosition: 50,
  art: "photo",
  subject: PHOTO_OBJECTS.has(slug) ? "object" : "person",
});
const coverFor = (slug: string, meta: ReferenceMetadata): ReferenceMetadata["cover"] =>
  PHOTO_COVER_SLUGS.has(slug) ? photoCover(slug) : meta.cover;
export const REFERENCE_METADATA: Record<string, ReferenceMetadata> = Object.fromEntries(
  Object.entries(metadata as unknown as Record<string, ReferenceMetadata>).map(([slug, meta]) => [
    slug,
    { ...meta, cover: coverFor(slug, meta) },
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
  LISTED_FUNDS.find((f) => f.slug === slug);
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
