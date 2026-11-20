import { LISTED_FUNDS } from './public-funds';
import type { ReferenceFund } from './public-funds';
import { TESTNET_97 } from './testnet-97';
import { launchName } from './fund-art';

/**
 * 主網可交易資產的地址 → 代號。
 *
 * 為什麼寫死在這裡：`GET /assets` 需要登入（401），但 Community 區塊與策略頁是公開頁；
 * 而這裡只需要「畫圖示／顯示代號」用的符號，不需要價格。沒收錄的地址退回縮短的 0x…。
 */
const KNOWN_ASSETS: Record<string, string> = {
  '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0x5b1910eaad6450e50f816082aa078c41f10c292f': 'TSLAB',
  '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1': 'SPCXB',
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'BTCB',
  '0xba2ae424d960c26247dd6c32edc70b295c744c43': 'DOGE',
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ETH',
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'WBNB',
};

/**
 * 測試網（chain 97）的模擬資產：地址 → 代號（`testnet-97.ts` 的地址簿反查）。
 * 沒有這張表時，測試網基金的持股全部顯示成 0x…（使用者 2026-11-17：「看起來很 lo」）。
 */
const TESTNET_ASSETS: Record<string, string> = Object.fromEntries([
  [TESTNET_97.contracts.usdt.toLowerCase(), 'USDT'],
  ...Object.entries(TESTNET_97.assets).map(([symbol, address]) => [address.toLowerCase(), symbol]),
]);

export function symbolOf(address: string): string {
  const key = address.toLowerCase();
  return KNOWN_ASSETS[key] ?? TESTNET_ASSETS[key] ?? `${address.slice(0, 4)}…${address.slice(-2)}`;
}

/**
 * 後端基金在參考目錄裡的對應（使用者 2026-11-20：用後端的 `catalogKey` 對應，不用名稱比對）。
 * 對到的話整檔沿用目錄的封面、介紹與資料（目前只有 Mag7）。
 */
export function catalogueTwin(catalogKey: string | null | undefined): ReferenceFund | undefined {
  if (!catalogKey) return undefined;
  return LISTED_FUNDS.find((fund) => fund.slug === catalogKey);
}

const NO_PERIODS = { '7D': null, '30D': null, '90D': null, '1Y': null, ALL: null };

/**
 * 把一檔後端基金做成 `ReferenceFund` 的形狀，讓列表與基金頁用同一套版面。
 *
 * 首發 21 檔（使用者 2026-11-20）：沒有目錄對應的基金**不顯示模擬報酬**。ATP 目前沒有基金層級的歷史 NAV，
 * 所以報酬、回撤、走勢一律空著，畫面顯示「—」。真的有實績之後再接上。
 *
 * 用在兩處：`/vaults` 的列表，以及 `/funds/strategy/:id` 的基金頁。
 */
export function synthesizeCommunityFund(args: {
  id: number;
  name: string;
  provider: string;
  onchainId: number | null;
  description: string;
  createdAt: string;
  positions: readonly { p: string; loc: string; w: number }[];
  catalogKey?: string | null;
}): ReferenceFund {
  const twin = catalogueTwin(args.catalogKey);
  if (twin !== undefined) return twin;
  const startedMs = Date.parse(args.createdAt);
  const runtimeDays = Number.isFinite(startedMs)
    ? Math.max(1, Math.round((Date.now() - startedMs) / 86_400_000))
    : 1;
  return {
    slug: `community-${args.id}`,
    // 首發 21 檔用英文名稱（後端名單是中文）；其他沿用後端名稱。
    name: launchName(args.catalogKey) ?? args.name,
    strategy: args.description || 'Community strategy',
    creator: args.provider,
    group: 'themes',
    tvl: 0,
    runtimeDays,
    returns: { ...NO_PERIODS },
    maxDrawdown: { ...NO_PERIODS },
    nav: [],
    symbol: 'CRE8',
    risk: 'High',
    sharePrice: 1,
    manager: `${args.provider.slice(0, 6)}…${args.provider.slice(-4)}`,
    fees: { perf: 0, mgmt: 0, platform: 0 },
    positions: args.positions,
    backtest: {
      start: args.createdAt.slice(0, 10),
      through: new Date().toISOString().slice(0, 10),
      basis: 'Model',
      composition: 'Target weights',
      rebalance: 'On drift',
      targets: args.positions.map((p, i) => ({
        id: `community-${args.id}-${i}`,
        symbol: p.loc,
        name: p.loc,
        weight: p.w,
      })),
    },
  } as ReferenceFund;
}

/**
 * 目錄基金（`/funds/:slug`）對應的後端基金：先看 `catalogKey`。後端還沒填 catalogKey 的舊資料才退回同名比對，
 * 有 catalogKey 的基金一律不靠名稱（使用者 2026-11-20）。找不到＝這檔目錄基金已下架。
 */
export function catalogueStrategy<T extends { name: string; catalogKey?: string | null }>(
  items: readonly T[],
  slug: string,
  name: string | undefined,
): T | undefined {
  return items.find((item) => item.catalogKey === slug)
    ?? (name === undefined ? undefined : items.find((item) => (item.catalogKey ?? null) === null && item.name === name));
}
