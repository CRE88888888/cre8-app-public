/**
 * 生息的地址簿（cre8-app#95 審查第 1、2 項）：只有 chain 97 有生息。
 *
 * 簽名前用這份核對後端給的 executor、yieldRegistry 與每個市場的固定身分；不符就停，不拿去組交易。
 * 來源是 `testnet-97.ts`（從 cre8-contracts manifest 產生，不手改）。
 */
import { TESTNET_97 } from './testnet-97';
import type { YieldBook } from './yield';

/** 有生息的鏈。其他鏈（主網、本機 fork）一律沒有：不取清單、不顯示入口、不送簽。 */
export const YIELD_CHAIN_ID = 97;

const BOOK_97: YieldBook = {
  chainId: TESTNET_97.chainId,
  executor: TESTNET_97.contracts.executor.toLowerCase(),
  registry: TESTNET_97.contracts.yieldRegistry.toLowerCase(),
  markets: TESTNET_97.yieldMarkets.map((market) => ({
    id: market.id,
    protocol: market.protocol,
    symbol: market.symbol,
    asset: market.asset.toLowerCase(),
    receipt: market.receipt.toLowerCase(),
    marketId: market.marketId.toLowerCase(),
  })),
};

export function yieldBookFor(chainId: number): YieldBook | null {
  return chainId === YIELD_CHAIN_ID ? BOOK_97 : null;
}
