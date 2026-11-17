/**
 * 上線時可上架的資產（cre8-app#51）。**之後新增或移除資產，只改這個檔案。**
 *
 * 來源：docs `research/2026-11-13-launch-admission/資料/admission.json` 裡 `admitted = true` 的項目
 * （docs#32，鏈上快照區塊 133316504）：38 個可交易資產，加上計價用的 USDT。
 * 同一份清單裡 `admitted = false` 的 5 個（ADA、LINK、MRVLB、BCH、NEAR）與清單以外的資產都不在這裡。
 *
 * 這個檔案決定三件事，全部由下面的清單推導，沒有第二份名單：
 *   1. 基金設計器的 Popular 列與「Browse all assets」哪些資產現在可以選（`isLaunchAsset`）。
 *   2. 展示基金哪幾檔可投資：成分全部在清單裡的那幾檔（`notOpenSymbols`；見 `launch-funds.ts`）。
 *   3. 畫面上的文案（`LAUNCH_COPY`）。
 *
 * 這是「顯示與引導」用的清單，不是安全邊界：真正能不能交易由合約的資產白名單與後端決定。
 * 純邏輯：不碰 React、不碰 fetch。
 */

export type LaunchAsset = {
  /** 鏈上代幣符號（`BTCB`、`NVDAB`、`SGOVon`）。展示基金的成分用這個比對。 */
  symbol: string;
  /** BNB Chain 主網的代幣位址（小寫）。設計器的資產用這個比對。 */
  address: string;
};

export const LAUNCH_ASSETS: readonly LaunchAsset[] = [
  // 計價資產：不需要交易就能持有。
  { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955' },
  { symbol: 'AAPLB', address: '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a' },
  { symbol: 'AMZNB', address: '0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00' },
  { symbol: 'AVAX', address: '0x1ce0c2827e2ef14d5c4f29a091d735a204794041' },
  { symbol: 'BABAB', address: '0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec' },
  { symbol: 'BTCB', address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c' },
  { symbol: 'CRCLB', address: '0x80f3d493ebce97e343c53d29a137942416b4ffc0' },
  { symbol: 'DAI', address: '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3' },
  { symbol: 'DJTB', address: '0xf2ec508422174ee564de98187db9359d318afb6b' },
  { symbol: 'DOGE', address: '0xba2ae424d960c26247dd6c32edc70b295c744c43' },
  { symbol: 'ETH', address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8' },
  { symbol: 'EWYB', address: '0xbe82f76637dba2c114c41df856c2c51e522e2cb8' },
  { symbol: 'GOOGLB', address: '0x3f53de71c126bdabae20f9cd64848d317f6c3238' },
  { symbol: 'HOODB', address: '0xa394dcea3fd3847fd793afbfd163e2e3858b7c65' },
  { symbol: 'INTCB', address: '0xe614e2fc6c787035ff51f452e8e826bfd32d5283' },
  { symbol: 'LTC', address: '0x4338665cbb7b2485a8855a139b75d5e34ab0db94' },
  { symbol: 'METAB', address: '0x7425889fe94f9d693e8daefe88bcced6acfef4c0' },
  { symbol: 'MRNAB', address: '0x5fd86da9b05abe396fe9d02a4a213a7c00556503' },
  { symbol: 'MSFTB', address: '0x80106cb3ead06659a5ad19df39d9b4733863b9b0' },
  { symbol: 'MSTRB', address: '0xe87afb3076aeb0f9b14e368de8145ae6a2826a14' },
  { symbol: 'MUB', address: '0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699' },
  { symbol: 'NFLXB', address: '0xd6829ea836b6fa224d099d40e54b31262f874631' },
  { symbol: 'NOKB', address: '0x7c4d7a180d737dd5a70d8065a90e6746a69c37ea' },
  { symbol: 'NVDAB', address: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436' },
  { symbol: 'QQQB', address: '0x205812cdbed920aff76c6580abd681a46d11efc7' },
  { symbol: 'SGOVon', address: '0xc008c5f579ec1450f20099c39f587547e27c7523' },
  { symbol: 'SKHYB', address: '0xca750ef65f295bbecd685abf54e82caf297bdb61' },
  { symbol: 'SNDKB', address: '0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb' },
  { symbol: 'SOL', address: '0x570a5d26f7765ecb712c0924e4de545b89fd43df' },
  { symbol: 'SPCXB', address: '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1' },
  { symbol: 'SPYB', address: '0x7138b48df7d98d7e3cc221bfe7192d0a178182d8' },
  { symbol: 'TLTon', address: '0xf69e40069ac227c11459e3f4e8a446b3401616b6' },
  { symbol: 'TRX', address: '0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3' },
  { symbol: 'TSLAB', address: '0x5b1910eaad6450e50f816082aa078c41f10c292f' },
  { symbol: 'TSMB', address: '0xab78b89b5bb00236be0b4b20704cbfa04efc711c' },
  { symbol: 'USDC', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' },
  { symbol: 'WBNB', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  { symbol: 'XAUt', address: '0x21caef8a43163eea865baee23b9c2e327696a3bf' },
  { symbol: 'XRP', address: '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe' },
];

/**
 * 設計器 Popular 列的資產（設計器自己的 key，不是鏈上符號：`BTC` → BTCB、`BNB` → WBNB、`NVDA` → NVDAB）。
 * 每一個都必須在上面的清單裡；不在的話設計器會自動略過，單元測試也會擋下來。
 */
export const POPULAR_ASSET_KEYS = ['BTC', 'ETH', 'BNB', 'SOL', 'NVDA', 'TSLA', 'AAPL', 'XAUT'] as const;

const BY_ADDRESS = new Set(LAUNCH_ASSETS.map((asset) => asset.address.toLowerCase()));
const BY_SYMBOL = new Set(LAUNCH_ASSETS.map((asset) => asset.symbol.toLowerCase()));

/** 這個代幣位址上線時可不可以上架（不分大小寫）。 */
export function isLaunchAsset(address: string | null | undefined): boolean {
  return typeof address === 'string' && BY_ADDRESS.has(address.toLowerCase());
}

/** 這個鏈上代幣符號上線時可不可以上架（不分大小寫）。 */
export function isLaunchSymbol(symbol: string | null | undefined): boolean {
  return typeof symbol === 'string' && BY_SYMBOL.has(symbol.toLowerCase());
}

/** 一組成分裡，上線時還不能上架的那幾個符號（照原順序、不重複）。空陣列 = 全部可上架。 */
export function notOpenSymbols(holdings: readonly { symbol: string }[]): string[] {
  const missing: string[] = [];
  for (const { symbol } of holdings) {
    if (!isLaunchSymbol(symbol) && !missing.includes(symbol)) missing.push(symbol);
  }
  return missing;
}

/** 畫面文案集中在這裡：白話、不誇大。 */
export const LAUNCH_COPY = {
  /** 設計器裡還不能選的資產。 */
  assetLater: 'After launch',
  assetLaterLong: 'Opens after launch',
  /** 基金清單上的短標示。 */
  fundOpen: 'Open to invest',
  fundPreview: 'Preview',
  /** 基金頁的說明。 */
  fundOpenLong: 'Open to invest.',
  fundPreviewLong: 'Preview only. This fund is not open for investment yet.',
} as const;
