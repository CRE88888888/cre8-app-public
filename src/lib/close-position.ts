/**
 * Close position（清倉）的兩個純判斷，從 FundPage 拆出來以便單元測試（cre8-app#23）。
 * 沒有 React、沒有 fetch；金額一律 BigInt。
 */

/** 掃回錢包時留在帳戶裡付**這一筆** UserOp 的 gas：一筆 sudo UserOp 約 0.000025 BNB，0.0005 是 20 倍餘裕。 */
export const SWEEP_GAS_RESERVE_WEI = 500_000_000_000_000n;

/**
 * 低於這個美元價值（1e8 定點）的非現金部位視為「沒有東西可賣」。
 *
 * 清倉賣完後帳戶裡一定剩一點賣不掉的渣（滑價與 wei 取整）。這些渣不值得再跑一次賣出，
 * 直接當代幣掃回錢包就好。門檻訂 1 美元：比任何渣都大，又小到不會把真的部位漏掉不賣。
 */
export const SELLABLE_FLOOR_USD_E8 = 100_000_000n;

/**
 * 掃回錢包的原生幣金額＝帳戶**現在**的餘額減掉保留的 gas；不夠保留就一毛都不掃。
 *
 * 結果一定 ≤ `balanceWei`。傳進來的餘額必須是賣完之後重新讀的 —— 用賣之前的數字
 * （賣出本身會花 gas）就會比實際多，整筆 sweep 在模擬時 revert。
 */
export function sweepNativeWei(balanceWei: bigint, reserveWei: bigint = SWEEP_GAS_RESERVE_WEI): bigint {
  return balanceWei > reserveWei ? balanceWei - reserveWei : 0n;
}

/**
 * 帳戶裡還有沒有值得賣的部位（現金以外、合計價值達門檻）。
 *
 * 沒有的話清倉就跳過「賣出」直接掃：這讓「賣完了、但掃回那一步失敗」的清倉可以再按一次完成 ——
 * 那時投組已經是 paused，後端的 `/close` 會拒絕，但其實也沒有東西要它賣了。
 */
export function hasSellablePositions(
  holdings: readonly { symbol: string; usdValueE8: string }[],
  cashSymbol: string,
  floorUsdE8: bigint = SELLABLE_FLOOR_USD_E8,
): boolean {
  let total = 0n;
  for (const row of holdings) {
    if (row.symbol === cashSymbol) continue;
    try {
      const value = BigInt(row.usdValueE8);
      if (value > 0n) total += value;
    } catch {
      // 價值讀不出來（非數字）→ 不知道值多少，保守當成「有部位」，交給後端賣。
      return true;
    }
  }
  return total >= floorUsdE8;
}

/** 兩個餘額讀數取較小的：只要其中一個是最新的，轉帳金額就不會超過實際餘額。 */
export function lowerOf(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
