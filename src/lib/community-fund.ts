import type { ReferenceFund } from './public-funds';

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

export function symbolOf(address: string): string {
  return KNOWN_ASSETS[address.toLowerCase()] ?? `${address.slice(0, 4)}…${address.slice(-2)}`;
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
  const nav = Array.from({ length: 24 }, (_, i) => {
    const date = new Date(startedMs + i * (runtimeDays / 23) * 86_400_000);
    return { t: date.getTime(), v: Math.round((1 + (oneYear / 100) * (i / 23) + (rand() - 0.5) / 50) * 1e6) / 1e6 };
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
