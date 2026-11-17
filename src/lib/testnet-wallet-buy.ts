/**
 * 測試網：用錢包裡的 USDT 買基金（cre8-app#114）。
 *
 * 原本測試網只有「領測試 USDT 直接進基金帳戶」一條路。賣出時 USDT 會回到錢包，所以使用者想用那筆錢買別檔時
 * 沒有路可走（使用者 2026-11-17）。現在測試網的下單面板兩種都給：
 *   - 錢包 USDT：輸入金額，跟主網一樣從錢包轉進基金帳戶。
 *   - 免費測試 USDT：照舊。
 *
 * 錢包 → 基金帳戶是一般的錢包交易，要付 tBNB；用 X／email 登入的嵌入式錢包沒有 tBNB，
 * 測試 USDT 也沒有 permit。所以轉帳前先檢查，不夠就請後端補（`POST /faucet/gas`）；
 * 轉帳確認後記成這檔的投入（funding lot，`wallet_transfer`），後端才會排進買入。
 */
import { parseEther, parseUnits } from 'viem';
import { MIN_SUBSCRIPTION_USDT, minimumDeposit } from './fund-execution';

export type TestnetPayWith = 'wallet' | 'faucet';

/** 沒選過時：錢包有 USDT 就用錢包，沒有就領免費的。 */
export function defaultPayWith(walletUsdt: bigint | null): TestnetPayWith {
  return walletUsdt !== null && walletUsdt > 0n ? 'wallet' : 'faucet';
}

/**
 * 錢包至少要有這麼多 tBNB 才直接轉；低於這個就請後端補。
 * BSC testnet 一筆 ERC20 transfer 約 0.000005 tBNB，這裡留 10 倍餘裕。後端（backend#149）在低於 0.0002 時
 * 補到 0.0005、每人每個 UTC 日一次，所以這個門檻一定低於後端的門檻：前端要求補的時候，後端一定會補。
 */
export const OWNER_GAS_NEEDED_WEI = parseEther('0.00005');
/** 後端補 gas 的門檻（backend#149）：低於這個才補。只用來在測試裡守住「前端門檻 < 後端門檻」。 */
export const BACKEND_GAS_TOPUP_BELOW_WEI = parseEther('0.0002');

/** 這筆投入的最低金額（USDT）：有生效版本的配置就照後端同一套算法，沒有就用最小認購。 */
export function walletBuyMinimum(assets: readonly { address: string; weightBps: number }[] | undefined, usdt: string | undefined): number {
  if (assets === undefined || assets.length === 0 || usdt === undefined) return MIN_SUBSCRIPTION_USDT;
  return minimumDeposit(assets, usdt);
}

/** 金額不能送出的原因（顯示在輸入框下面）；可以送出時回 null。 */
export function walletBuyProblem(input: { amount: string; decimals: number; walletUsdt: bigint | null; minimum: number }): string | null {
  const { amount, decimals, walletUsdt, minimum } = input;
  let value: bigint;
  try {
    value = parseUnits(amount === '' ? '0' : amount, decimals);
  } catch {
    return 'Enter a valid amount.';
  }
  if (value <= 0n) return null; // 還沒輸入：不說話，按鈕本來就是停用的。
  if (walletUsdt !== null && value > walletUsdt) return 'This amount exceeds your wallet balance.';
  if (value < parseUnits(String(minimum), decimals)) return `The minimum is ${minimum} USDT.`;
  return null;
}

export class OwnerGasError extends Error {
  constructor(detail?: string) {
    super(`Couldn’t get the network fee for this transfer. Nothing was transferred. Try again in a minute.${detail ? ` (${detail})` : ''}`);
    this.name = 'OwnerGasError';
  }
}

/**
 * 轉帳前確保錢包有 tBNB：夠就直接過；不夠就請後端補，等那筆上鏈後再查一次，還是不夠就丟 `OwnerGasError`（不轉錢）。
 */
export async function ensureOwnerGas(deps: {
  readBalance: () => Promise<bigint>;
  requestGas: () => Promise<{ txHash: string | null; amountWei?: string }>;
  waitForTx: (hash: string) => Promise<void>;
  needed?: bigint;
}): Promise<'enough' | 'topped-up'> {
  const needed = deps.needed ?? OWNER_GAS_NEEDED_WEI;
  if (await deps.readBalance() >= needed) return 'enough';
  let granted: { txHash: string | null };
  try {
    granted = await deps.requestGas();
  } catch (cause) {
    throw new OwnerGasError(cause instanceof Error ? cause.message : String(cause));
  }
  if (granted.txHash !== null) await deps.waitForTx(granted.txHash);
  if (await deps.readBalance() < needed) throw new OwnerGasError();
  return 'topped-up';
}
