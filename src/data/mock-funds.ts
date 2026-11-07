/**
 * 範例基金（design prototype 的 mock 清單）。
 *
 * 來源：`bnb-agent-vaults/web/lib/demo-funds.ts` 的 9 個示範基金，取其中的**結構性欄位**
 * （slug / name / symbol / thesis / risk / rebalance / targets）。
 *
 * ⚠ 刻意**不**帶報酬率、回撤、走勢圖：那些數字在來源站是模擬回測的產物，而這個部署沒有那條資料管線。
 *   把模擬值搬過來、或自己編一個，都會讓使用者以為那是真的績效。所以卡片右側顯示
 *   `Risk` 與 `Rebalance period` —— 兩者都是這份定義的一部分，不是算出來的。
 *
 * 這些基金**不能買**：它們只是讓 vaults 頁看起來像一個真的目錄，並示範「策略就是資料」
 * （targets 的形狀與 `strategy_versions.allocation.assets` 相同：address/symbol + weightBps）。
 * 可投資的只有 `live` 那一區（真的在 DB 與鏈上的投組）。
 */

export type MockHolding = {
  symbol: string;
  /** bps（10000 = 100%）。與後端 `allocation.assets[].weightBps` 同一個單位。 */
  weightBps: number;
};

export type MockFund = {
  slug: string;
  name: string;
  symbol: string;
  thesis: string;
  risk: 'High' | 'Medium' | 'Low';
  /** 再平衡節奏；`none` = 不自動再平衡。 */
  rebalance: 'monthly' | 'drift' | 'none';
  holdings: MockHolding[];
};

/** 權重總和檢查：範例資料也要自洽，不然畫面會出現「100% 卻少 3%」這種沒人會去查的錯。 */
export const MOCK_FUNDS: MockFund[] = [
  {
    slug: 'mag7',
    name: 'Mag7',
    symbol: 'M7',
    thesis: 'Seven technology leaders, in equal target weights.',
    risk: 'High',
    rebalance: 'monthly',
    holdings: [
      { symbol: 'AAPL', weightBps: 1429 },
      { symbol: 'MSFT', weightBps: 1429 },
      { symbol: 'GOOGL', weightBps: 1429 },
      { symbol: 'AMZN', weightBps: 1429 },
      { symbol: 'NVDA', weightBps: 1428 },
      { symbol: 'META', weightBps: 1428 },
      { symbol: 'TSLA', weightBps: 1428 },
    ],
  },
  {
    slug: 'ai-buildout',
    name: 'AI Buildout',
    symbol: 'AIB',
    thesis: 'The physical buildout of AI: chips, memory, data centers and power.',
    risk: 'High',
    rebalance: 'monthly',
    holdings: [
      { symbol: 'NVDA', weightBps: 2000 },
      { symbol: 'AMD', weightBps: 1000 },
      { symbol: 'AVGO', weightBps: 1500 },
      { symbol: 'TSM', weightBps: 1500 },
      { symbol: 'MU', weightBps: 1000 },
      { symbol: 'VRT', weightBps: 1000 },
      { symbol: 'CEG', weightBps: 1000 },
      { symbol: 'GEV', weightBps: 1000 },
    ],
  },
  {
    slug: 'multi-asset-balanced',
    name: 'Multi-Asset Balanced',
    symbol: 'MAB',
    thesis: 'US equities, Treasuries, gold and Bitcoin in one allocation.',
    risk: 'Medium',
    rebalance: 'drift',
    holdings: [
      { symbol: 'SPY', weightBps: 3500 },
      { symbol: 'IEF', weightBps: 2000 },
      { symbol: 'TLT', weightBps: 1000 },
      { symbol: 'XAU', weightBps: 2000 },
      { symbol: 'BTC', weightBps: 1000 },
      { symbol: 'USDT', weightBps: 500 },
    ],
  },
  {
    slug: 'crypto-leaders',
    name: 'Crypto Leaders',
    symbol: 'CR10',
    thesis: 'Ten major crypto assets, with Bitcoin and Ethereum at the core.',
    risk: 'High',
    rebalance: 'monthly',
    holdings: [
      { symbol: 'BTC', weightBps: 3000 },
      { symbol: 'ETH', weightBps: 2000 },
      { symbol: 'BNB', weightBps: 1000 },
      { symbol: 'SOL', weightBps: 1000 },
      { symbol: 'XRP', weightBps: 1000 },
      { symbol: 'DOGE', weightBps: 500 },
      { symbol: 'ADA', weightBps: 500 },
      { symbol: 'TRX', weightBps: 400 },
      { symbol: 'AVAX', weightBps: 300 },
      { symbol: 'LINK', weightBps: 300 },
    ],
  },
  {
    slug: 'treasury-reserve',
    name: 'Treasury Reserve',
    symbol: 'UST',
    thesis: 'Short-term US Treasuries, with smaller medium- and long-term allocations.',
    risk: 'Medium',
    rebalance: 'monthly',
    holdings: [
      { symbol: 'SGOV', weightBps: 7000 },
      { symbol: 'IEF', weightBps: 2000 },
      { symbol: 'TLT', weightBps: 1000 },
    ],
  },
  {
    slug: 'elon-universe',
    name: 'Elon Universe',
    symbol: 'ELON',
    thesis: 'Tesla and SpaceX, alongside Bitcoin, Dogecoin and Ethereum.',
    risk: 'High',
    rebalance: 'none',
    holdings: [
      { symbol: 'TSLA', weightBps: 3500 },
      { symbol: 'SPCX', weightBps: 3500 },
      { symbol: 'BTC', weightBps: 1500 },
      { symbol: 'DOGE', weightBps: 1000 },
      { symbol: 'ETH', weightBps: 500 },
    ],
  },
  {
    slug: 'pelosi-disclosed-equity',
    name: 'Pelosi Disclosed Equity',
    symbol: 'PDE',
    thesis: 'A ten-stock selection from publicly disclosed Pelosi household equity transactions.',
    risk: 'High',
    rebalance: 'none',
    holdings: [
      { symbol: 'GOOGL', weightBps: 1100 },
      { symbol: 'AMZN', weightBps: 1100 },
      { symbol: 'AAPL', weightBps: 1100 },
      { symbol: 'AVGO', weightBps: 1100 },
      { symbol: 'MSFT', weightBps: 1100 },
      { symbol: 'NVDA', weightBps: 1100 },
      { symbol: 'CRM', weightBps: 1099 },
      { symbol: 'BE', weightBps: 767 },
      { symbol: 'INTC', weightBps: 767 },
      { symbol: 'VST', weightBps: 767 },
    ],
  },
  {
    slug: 'berkshire-disclosed-equities',
    name: 'Berkshire Disclosed Equities',
    symbol: 'BDE',
    thesis: "A mixed-issuer basket drawn from Berkshire's disclosed equity portfolio.",
    risk: 'High',
    rebalance: 'none',
    holdings: [
      { symbol: 'AAPL', weightBps: 2690 },
      { symbol: 'AXP', weightBps: 2092 },
      { symbol: 'GOOGL', weightBps: 1540 },
      { symbol: 'KO', weightBps: 1326 },
      { symbol: 'BAC', weightBps: 1123 },
      { symbol: 'CVX', weightBps: 570 },
      { symbol: 'OXY', weightBps: 525 },
      { symbol: 'VRSN', weightBps: 92 },
      { symbol: 'COF', weightBps: 25 },
      { symbol: 'NUE', weightBps: 17 },
    ],
  },
  {
    slug: 'trump-universe',
    name: 'Trump Universe',
    symbol: 'TRMP',
    thesis: 'A public-disclosure equity selection with DJT and a planned WLFI allocation.',
    risk: 'High',
    rebalance: 'none',
    holdings: [
      { symbol: 'DJT', weightBps: 2000 },
      { symbol: 'AAPL', weightBps: 1416 },
      { symbol: 'NVDA', weightBps: 1360 },
      { symbol: 'MSFT', weightBps: 971 },
      { symbol: 'AMZN', weightBps: 927 },
      { symbol: 'AVGO', weightBps: 899 },
      { symbol: 'META', weightBps: 772 },
      { symbol: 'TSLA', weightBps: 766 },
      { symbol: 'JPM', weightBps: 389 },
      { symbol: 'WLFI', weightBps: 500 },
    ],
  },
];

/** 這份清單自己的不變量：每個基金的權重必須剛好 10000 bps。 */
export function assertMockFundsConsistent(funds: readonly MockFund[] = MOCK_FUNDS): void {
  for (const fund of funds) {
    const total = fund.holdings.reduce((sum, holding) => sum + holding.weightBps, 0);
    if (total !== 10_000) {
      throw new Error(`mock fund ${fund.slug} 的權重總和是 ${total} bps，不是 10000`);
    }
  }
}
