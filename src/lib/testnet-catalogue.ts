/**
 * 測試網（chain 97）上展示哪些基金、哪些資產可以選（cre8-app#86）。
 *
 * 使用者 2026-11-15 決定：測試網只展示 16 檔基金（刪掉負報酬與持倉過多的 14 檔），資產用
 * cre8-contracts#43 的 92 個（`testnet-97.ts`）。主網行為不在這裡：主網仍看 `launch-admission.ts` 的 38 個。
 *
 * 其餘 14 檔的資料保留在目錄裡，只是測試網不列出來、也不開放投資。
 * 純邏輯：不碰 React、不碰 fetch。是否為測試網由 `VITE_CHAIN_ID` 決定（與 `lib/kernel.ts` 同一個來源），
 * 函式都另外收一個 `testnet` 參數，單元測試不必改環境變數。
 */
import { TESTNET_97 } from './testnet-97';
import { readChainId } from './chain-config';

export const IS_TESTNET = readChainId(import.meta.env.VITE_CHAIN_ID) === TESTNET_97.chainId;

/** 測試網列出的 16 檔（照 cre8-app#86 的順序）。 */
export const TESTNET_LISTED_SLUGS: readonly string[] = [
  'leopold-aschenbrenner-situational',
  'gavin-baker-atreides',
  'ken-griffin-citadel',
  'ai-buildout',
  'ray-dalio-bridgewater',
  'lyn-alden-x',
  'david-einhorn-dme',
  'berkshire-disclosed-equities',
  'pelosi-disclosed-equity',
  'mag7',
  'bill-ackman-pershing',
  'stanley-druckenmiller-duquesne',
  'treasury-reserve',
  'ming-chi-kuo-x',
  'raoul-pal-x',
  'multi-asset-balanced',
];

const LISTED = new Set(TESTNET_LISTED_SLUGS);

/** 測試網上有的鏈上符號（小寫）：92 個模擬資產加上測試 USDT。 */
const SYMBOLS = new Map<string, string>([
  ['usdt', TESTNET_97.contracts.usdt],
  ...Object.entries(TESTNET_97.assets).map(([symbol, token]) => [symbol.toLowerCase(), token] as [string, string]),
]);

/** 這個鏈上符號在測試網上有沒有（不分大小寫）。 */
export function isTestnetSymbol(symbol: string | null | undefined): boolean {
  return typeof symbol === 'string' && SYMBOLS.has(symbol.toLowerCase());
}

/** 鏈上符號在測試網上的代幣地址（不分大小寫）；沒有就回 null。 */
export function testnetToken(symbol: string | null | undefined): string | null {
  return (typeof symbol === 'string' && SYMBOLS.get(symbol.toLowerCase())) || null;
}

/** 這檔展示基金要不要列出來：主網全部列；測試網只列那 16 檔。 */
export function isListedFund(slug: string, testnet: boolean = IS_TESTNET): boolean {
  return !testnet || LISTED.has(slug);
}

/** 只留要列出來的基金。回傳的是同一批物件（參考資料更新時會就地改寫，畫面跟著變）。 */
export function listedFunds<T extends { slug: string }>(funds: readonly T[], testnet: boolean = IS_TESTNET): T[] {
  return funds.filter((fund) => isListedFund(fund.slug, testnet));
}
