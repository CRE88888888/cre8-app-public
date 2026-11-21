/**
 * My mix 能選的 40 個資產（cre8-app#132）：就是首發 21 檔基金用到的成分，與後端 `MIX_ASSETS`
 * （`src/model-returns/assets.json`）同一份。後端沒有附名稱和分類的清單端點，所以名稱、分類、
 * 熱門順序放在 App；地址一律從測試網地址簿讀，不另抄一份。
 *
 * 畫面上的代號去掉 bStock 的尾碼 B（NVDAB → NVDA），幣用大家熟的名字（BTCB → BTC）。
 */
import { TESTNET_97 } from '../../lib/testnet-97';
import type { Address } from './mix-types';

export type MixGroup = 'ai' | 'big-tech' | 'crypto' | 'etf' | 'leveraged' | 'more';

export type MixCatalogAsset = {
  /** 鏈上符號（後端與地址簿用的）。 */
  symbol: string;
  /** 畫面上的代號。 */
  ticker: string;
  name: string;
  group: MixGroup;
  /** 槓桿 ETF：卡片標 Risky。 */
  risky?: boolean;
  /** 加密資產 24 小時都能買；其他跟美股開收盤。 */
  crypto?: boolean;
  address: Address;
};

export const MIX_GROUPS: { id: MixGroup; label: string }[] = [
  { id: 'ai', label: 'AI' },
  { id: 'big-tech', label: 'Big Tech' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'etf', label: 'ETF' },
  { id: 'leveraged', label: 'Leveraged' },
  { id: 'more', label: 'More' },
];

/** 選股頁最上面「熱門」的順序。 */
export const POPULAR = ['NVDAB', 'TSLAB', 'BTCB', 'AAPLB', 'SPCXB', 'MSTRB', 'QQQB', 'WBNB'] as const;

type Row = [symbol: string, ticker: string, name: string, group: MixGroup, flags?: { risky?: true; crypto?: true }];

const ROWS: Row[] = [
  ['NVDAB', 'NVDA', 'NVIDIA', 'ai'],
  ['TSMB', 'TSM', 'TSMC', 'ai'],
  ['AVGOB', 'AVGO', 'Broadcom', 'ai'],
  ['MUB', 'MU', 'Micron', 'ai'],
  ['SKHYB', 'SKHY', 'SK hynix', 'ai'],
  ['INTCB', 'INTC', 'Intel', 'ai'],
  ['MRVLB', 'MRVL', 'Marvell', 'ai'],
  ['SNDKB', 'SNDK', 'Sandisk', 'ai'],
  ['PENGB', 'PENG', 'Penguin Solutions', 'ai'],
  ['ANTB', 'ANT', 'Anthropic', 'ai'],
  ['SPCXB', 'SPCX', 'SpaceX', 'ai'],
  ['AAPLB', 'AAPL', 'Apple', 'big-tech'],
  ['MSFTB', 'MSFT', 'Microsoft', 'big-tech'],
  ['GOOGLB', 'GOOGL', 'Alphabet', 'big-tech'],
  ['AMZNB', 'AMZN', 'Amazon', 'big-tech'],
  ['METAB', 'META', 'Meta', 'big-tech'],
  ['TSLAB', 'TSLA', 'Tesla', 'big-tech'],
  ['NFLXB', 'NFLX', 'Netflix', 'big-tech'],
  ['RDDTB', 'RDDT', 'Reddit', 'big-tech'],
  ['BABAB', 'BABA', 'Alibaba', 'big-tech'],
  ['PDDB', 'PDD', 'PDD Holdings', 'big-tech'],
  ['BTCB', 'BTC', 'Bitcoin', 'crypto', { crypto: true }],
  ['WBNB', 'BNB', 'BNB', 'crypto', { crypto: true }],
  ['DOGE', 'DOGE', 'Dogecoin', 'crypto', { crypto: true }],
  ['MSTRB', 'MSTR', 'Strategy', 'crypto'],
  ['COINB', 'COIN', 'Coinbase', 'crypto'],
  ['CRCLB', 'CRCL', 'Circle', 'crypto'],
  ['HOODB', 'HOOD', 'Robinhood', 'crypto'],
  ['BMNRB', 'BMNR', 'BitMine', 'crypto'],
  ['BNCB', 'BNC', 'BNB Standard', 'crypto'],
  ['CYPHB', 'CYPH', 'Cypherpunk', 'crypto'],
  ['SPYB', 'SPY', 'S&P 500', 'etf'],
  ['QQQB', 'QQQ', 'Nasdaq 100', 'etf'],
  ['EWYB', 'EWY', 'South Korea', 'etf'],
  ['SOXLB', 'SOXL', 'Chips 3x', 'leveraged', { risky: true }],
  ['TQQQB', 'TQQQ', 'Nasdaq 100 3x', 'leveraged', { risky: true }],
  ['XAUt', 'GOLD', 'Gold', 'more', { crypto: true }],
  ['GMEB', 'GME', 'GameStop', 'more'],
  ['AMCB', 'AMC', 'AMC', 'more'],
  ['DJTB', 'DJT', 'Trump Media', 'more'],
];

const BOOK = TESTNET_97.assets as Record<string, string>;

export const MIX_CATALOG: readonly MixCatalogAsset[] = ROWS.map(([symbol, ticker, name, group, flags]) => {
  const address = BOOK[symbol];
  if (address === undefined) throw new Error(`My mix asset ${symbol} is missing from the testnet address book`);
  return { symbol, ticker, name, group, address: address.toLowerCase() as Address, ...flags };
});

const BY_SYMBOL = new Map(MIX_CATALOG.map((asset) => [asset.symbol, asset]));
const BY_ADDRESS = new Map(MIX_CATALOG.map((asset) => [asset.address, asset]));

export function mixAsset(symbol: string): MixCatalogAsset | undefined {
  return BY_SYMBOL.get(symbol);
}

export function mixAssetByAddress(address: string): MixCatalogAsset | undefined {
  return BY_ADDRESS.get(address.toLowerCase() as Address);
}

/** 搜尋：代號、鏈上符號、名稱都能找（不分大小寫，忽略空白）。 */
export function searchMixAssets(query: string, assets: readonly MixCatalogAsset[] = MIX_CATALOG): MixCatalogAsset[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (q === '') return [...assets];
  return assets.filter((asset) =>
    asset.ticker.toLowerCase().includes(q) || asset.symbol.toLowerCase().includes(q) || asset.name.toLowerCase().includes(q));
}
