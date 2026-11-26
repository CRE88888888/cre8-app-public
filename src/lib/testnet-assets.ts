/**
 * 測試網上，設計器目錄裡「主網還不能交易」的加密資產改成可交易（總管 2026-11-15）。
 *
 * - ZEC：主網沒有 BNB Chain 上的價格來源（`no-feed`），測試網有自己的模擬池和價格。
 * - TON、DOT、SHIB、PEPE、AAVE、CAKE、FIL、ATOM（cre8-app#89 補進目錄的 8 個）：主網只能規劃（`preview`），
 *   測試網有模擬池。不打開的話它們只能 Buy & hold，不能逐資產選 Stack。
 *
 * 只動測試網地址簿（`testnet-97.ts`）裡有的加密資產；主網完全不動。參考目錄 `src/reference/` 不能手改，
 * 所以在 app 載入時就地改它的 status（同一批物件，設計器與啟用頁讀到的都是改過的）。
 */
import { ASSETS, type Asset } from '../reference/lib/fund-builder';
import { IS_TESTNET, isTestnetSymbol } from './testnet-catalogue';

/** 把測試網有的 preview／no-feed 加密資產改成 ready；回傳改了哪些 key。重複呼叫不會再改。 */
export function openTestnetCrypto(assets: readonly Asset[] = ASSETS, testnet: boolean = IS_TESTNET): string[] {
  if (!testnet) return [];
  const opened: string[] = [];
  for (const asset of assets) {
    if (asset.category !== 'crypto' || (asset.status !== 'preview' && asset.status !== 'no-feed') || !isTestnetSymbol(asset.symbol)) continue;
    (asset as { status: Asset['status'] }).status = 'ready';
    opened.push(asset.key);
  }
  return opened;
}

/** 改之前（主網）的 status，給測試在任何鏈上都能拿到同一份原始資料（cre8-app#93）。 */
export const MAINNET_STATUS: ReadonlyMap<string, Asset['status']> = new Map(ASSETS.map((asset) => [asset.key, asset.status]));

openTestnetCrypto();
