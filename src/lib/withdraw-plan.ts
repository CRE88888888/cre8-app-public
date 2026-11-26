/**
 * 提領（Sell）的幾個純判斷，從 FundPage 拆出來以便單元測試（cre8-app#49）。
 * 沒有 React、沒有 fetch。
 *
 * 背景：提領原本用頁面上快取的 status 算「現金夠不夠」。頁面資料舊的時候（剛存款、排程器在背景
 * 又買了幾批）會以為現金夠，完全不賣出，只把帳戶裡實際有的 USDT 轉出，還說成「沒有可賣的部位」。
 * 現在的規則：送出前一定重讀 status，下面這些函式只吃**剛讀到的**那一份。
 */
import { hasSellablePositions } from './close-position';

type HoldingValue = { symbol: string; usdValueE8: string };

/** 賣出量要放大的比例：賣掉 $X 的部位換不到 $X 的 USDT（池費、地板折扣、價格衝擊）。 */
export const SELL_BUFFER = 0.06;

/** 低於這個缺口（美元）就不賣：一分錢的誤差不值得送一筆交易。 */
const SHORTFALL_FLOOR_USD = 0.01;

/** 帳戶裡的現金（計價資產）價值，美元。讀不出來當 0：寧可多賣一輪，也不要以為現金夠。 */
export function cashUsdOf(holdings: readonly HoldingValue[], cashSymbol: string): number {
  const row = holdings.find((entry) => entry.symbol === cashSymbol);
  if (row === undefined) return 0;
  const value = Number(row.usdValueE8) / 1e8;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** status 的 `totalUsdE8` → 美元；讀不出來是 0。 */
export function totalUsdOf(totalUsdE8: string | null | undefined): number {
  if (totalUsdE8 === null || totalUsdE8 === undefined) return 0;
  const value = Number(totalUsdE8) / 1e8;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 這一輪要請後端賣多少美元的部位；`null` = 現金已經夠，不用賣。
 *
 * `cashUsd` 必須是**剛讀到的**現金。缺口按 1/(1−緩衝) 放大，並進位到 1e-6。
 */
export function sellTargetUsd(wantedUsd: number, cashUsd: number, buffer: number = SELL_BUFFER): number | null {
  const shortfall = wantedUsd - cashUsd;
  if (!(shortfall > SHORTFALL_FLOOR_USD)) return null;
  return Math.ceil((shortfall / (1 - buffer)) * 1e6) / 1e6;
}

const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * 轉出的比要求的少時，給使用者的說明；沒有少（差不到一分錢）回 null。
 *
 * 「沒有可賣的部位」只在最新的 status 真的沒有部位時才說。還有部位卻沒賣到，
 * 說的是「這次賣不動」，並附上後端給的原因 —— 錢還在基金裡，使用者可以再試。
 */
export function withdrawShortfallNote(input: {
  sentUsd: number;
  askedUsd: number;
  /** 賣完之後最新的持倉。 */
  holdings: readonly HoldingValue[];
  cashSymbol: string;
  /**
   * 賣不動的原因：**一句完整的白話英文**（`explainTradeFailure` 的 `summary`）。認不出原因或沒有賣過就不傳。
   * 後端的原文不要放進來，由呼叫端收進可展開的細節（cre8-app#55）。
   */
  cause?: string | null;
}): string | null {
  const missing = input.askedUsd - input.sentUsd;
  if (!(missing > SHORTFALL_FLOOR_USD)) return null;
  const head = `Sent ${usd(input.sentUsd)} of the ${usd(input.askedUsd)} you asked for`;
  if (!hasSellablePositions(input.holdings, input.cashSymbol)) {
    return `${head} — the account has no positions left to sell.`;
  }
  const cause = input.cause?.trim();
  return (
    `${head} — the remaining ${usd(missing)} could not be sold right now. ` +
    `${cause ? `${cause} ` : ''}Your positions are still in the fund; you can try again.`
  );
}
