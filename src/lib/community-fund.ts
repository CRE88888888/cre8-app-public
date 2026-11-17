import { REFERENCE_FUNDS } from './public-funds';
import type { ReferenceFund } from './public-funds';
import { TESTNET_97 } from './testnet-97';

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
 * 鏈上策略在參考目錄裡的同名基金（使用者 2026-11-17：測試網可以買的基金要跟正式的一樣，圖片與內容都用正式的）。
 * 參考目錄的基金頁本來就用同一個名稱找到要買的鏈上策略（FundPage 的 slug 模式），兩邊對應的是同一檔。
 */
export function catalogueTwin(name: string): ReferenceFund | undefined {
  return REFERENCE_FUNDS.find((fund) => fund.name === name);
}

/** 確定性亂數：同一個 seed 永遠得到同一個序列（重整不會讓數字跳動）。 */
function seeded(seed: number): () => number {
  let state = seed * 9301 + 49297;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

/**
 * 合成一檔「看起來像參考基金」的社群策略。
 *
 * ⚠ 報酬與 NAV 是**模型值**，不是這檔策略的實績 —— ATP 目前沒有基金層級的歷史 NAV。
 * 用確定性亂數是刻意的：每次重整都換一組數字會讓畫面看起來像壞掉，也讓人誤以為是真實行情。
 *
 * 用在兩處：`/vaults` 的 Community 區塊（列表），以及 `/strategies/:id` 的詳情頁
 * （要跟 `/funds/:slug` 同一套版面，就需要一個 ReferenceFund 形狀的物件餵給 FundOverview）。
 */
export function synthesizeCommunityFund(args: {
  id: number;
  name: string;
  provider: string;
  onchainId: number | null;
  description: string;
  createdAt: string;
  positions: readonly { p: string; loc: string; w: number }[];
  seed: number;
}): ReferenceFund {
  // 有同名的參考基金：整檔沿用（封面、人物介紹、說明、模型報酬、持股更新），畫面跟正式的一樣。
  const twin = catalogueTwin(args.name);
  if (twin !== undefined) return twin;
  const rand = seeded(args.seed);
  const drift = args.positions.reduce((sum, p) => sum + p.w * (rand() - 0.45), 0);
  const oneYear = Math.round(drift * 10) / 10;
  const periods: Record<string, number> = {
    '7D': Math.round(oneYear * 0.06 * 10) / 10,
    '30D': Math.round(oneYear * 0.22 * 10) / 10,
    '90D': Math.round(oneYear * 0.48 * 10) / 10,
    '1Y': oneYear,
    ALL: oneYear,
  };
  const startedMs = Date.parse(args.createdAt);
  const runtimeDays = Number.isFinite(startedMs)
    ? Math.max(1, Math.round((Date.now() - startedMs) / 86_400_000))
    : 1;
  // NAV 的首尾**必須**等於 returns['1Y'] 的隱含值：
  // `periodMetrics` 對 1Y 是從 nav 算 `(last/first - 1) * 100`，而列表其他期間用 returns。
  // 兩者不一致的話，同一個策略在列表與詳情頁會顯示不同的報酬（實際發生過：+19% vs −24%）。
  // 所以：首點固定 1、末點固定 1 + oneYear/100，中間用確定性擾動但仍收在直線上。
  const last = 23;
  const nav = Array.from({ length: 24 }, (_, i) => {
    const date = new Date(startedMs + i * (runtimeDays / last) * 86_400_000);
    const trend = 1 + (oneYear / 100) * (i / last);
    // 兩端歸零的擾動（sin 形式），保證 i=0 與 i=last 不偏移。
    const wobble = Math.sin((i / last) * Math.PI) * (rand() - 0.5) / 40;
    return { t: date.getTime(), v: Math.round((trend + wobble) * 1e6) / 1e6 };
  });
  return {
    slug: `community-${args.id}`,
    name: args.name,
    strategy: args.description || 'Community strategy',
    creator: args.provider,
    group: 'themes',
    tvl: Math.round(drift * 1200),
    runtimeDays,
    returns: periods,
    maxDrawdown: { '7D': null, '30D': null, '90D': null, '1Y': null, ALL: null },
    nav,
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
