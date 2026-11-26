/**
 * 交易場所（venue）的對照與顯示（cre8-app#47，A11）。純邏輯：不碰 React、不碰 fetch。
 *
 * 背景：executor 的每一步交易（SwapStep）帶一個 `venue` —— 那一步實際呼叫的 router 位址。
 * 後端會在 PancakeSwap 與 KyberSwap 之間挑淨得量較好的那個，所以同一筆交易裡不同步可以走不同場所。
 *
 * venue 的兩個來源：
 *   1. 後端的即時回應（`/rebalance`、`/plan`、`/redeem`、`/close` 的 `steps[].venue`）。
 *   2. 交易紀錄（`/activity`）沒有 steps，後端 DB 也沒存 venue，鏈上的 `SwapExecuted` 事件也不帶。
 *      歷史紀錄只能從那筆交易的 calldata 解回來：見 `decodeRebalanceSteps`。
 */
import { decodeFunctionData, isAddress, toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { shortAddress } from './format';

/** PancakeSwap Universal Router（BNB Chain 主網）。與 backend `src/chain.ts` 的 `PANCAKE_UR` 相同。 */
export const PANCAKE_UNIVERSAL_ROUTER = '0x1a0a18ac4becddbd6389559687d1a73d8927e416';
/** KyberSwap MetaAggregationRouterV2。 */
export const KYBERSWAP_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';

/** 位址（小寫）→ 顯示名稱。新增場所只要加一行。 */
const KNOWN_VENUES: Readonly<Record<string, string>> = {
  [PANCAKE_UNIVERSAL_ROUTER.toLowerCase()]: 'PancakeSwap',
  [KYBERSWAP_ROUTER.toLowerCase()]: 'KyberSwap',
};

/**
 * router 位址 → 給使用者看的名稱。
 *
 * - 認得的位址（不分大小寫）→ `PancakeSwap`／`KyberSwap`。
 * - 不認得的位址 → 縮寫位址（`0x1234…abcd`）。不猜、不寫成 "Unknown"：使用者可以拿去查。
 * - 沒有值，或不是位址（舊後端沒有這個欄位）→ `null`，呼叫端就不顯示場所。
 */
export function venueName(venue: string | null | undefined): string | null {
  if (typeof venue !== 'string' || !isAddress(venue, { strict: false })) return null;
  return KNOWN_VENUES[venue.toLowerCase()] ?? shortAddress(venue);
}

/** 一步交易裡，顯示場所需要的欄位。`venue` 可能不存在（舊後端）。 */
export type RoutedStep = { tokenIn: string; tokenOut: string; venue?: string | null };

export type TradeRoute = {
  /** 賣出的代幣代號。 */
  from: string;
  /** 買進的代幣代號。 */
  to: string;
  /** 場所名稱；不知道時為 null。 */
  venue: string | null;
  /** 同一組（賣什麼、買什麼、走哪裡）出現了幾步。分批賣出時同一組會重複很多次。 */
  count: number;
};

/**
 * 把 steps 整理成畫面上的列：每一列是「賣什麼 → 買什麼，走哪個場所」。
 *
 * 相同的（tokenIn、tokenOut、venue）合併成一列並計數，順序照第一次出現的順序。
 * 不合併的話，分批賣出（最多 20 批）會把同一行重複印 20 次。
 */
export function tradeRoutes(steps: readonly RoutedStep[], symbolOf: (asset: string) => string): TradeRoute[] {
  const rows = new Map<string, TradeRoute>();
  for (const step of steps) {
    const venue = venueName(step.venue);
    const key = `${step.tokenIn.toLowerCase()}>${step.tokenOut.toLowerCase()}@${venue ?? ''}`;
    const row = rows.get(key);
    if (row === undefined) rows.set(key, { from: symbolOf(step.tokenIn), to: symbolOf(step.tokenOut), venue, count: 1 });
    else row.count += 1;
  }
  return [...rows.values()];
}

/** 這些 steps 裡有沒有任何一步知道場所。都不知道（舊後端）就整塊不顯示。 */
export function hasVenue(steps: readonly RoutedStep[]): boolean {
  return steps.some((step) => venueName(step.venue) !== null);
}

/**
 * 一句話版本，給放不下清單的地方（toast）：`"KyberSwap ×2, PancakeSwap"`。
 * 沒有任何一步知道場所時回 null。
 */
export function venueSummary(steps: readonly RoutedStep[]): string | null {
  const counts = new Map<string, number>();
  for (const step of steps) {
    const venue = venueName(step.venue);
    if (venue !== null) counts.set(venue, (counts.get(venue) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts].map(([venue, count]) => (count > 1 ? `${venue} ×${count}` : venue)).join(', ');
}

// ---------------------------------------------------------------------------
// 從交易的 calldata 解回 steps（交易紀錄用）
// ---------------------------------------------------------------------------

/**
 * A11 的 `executeRebalance(account, SwapStep[], deadline)`。
 * 與 backend `src/chain.ts` 的 `EXECUTOR_ABI`／`SWAP_STEP_COMPONENTS` 相同（合約 main `f21785b`）。
 */
export const EXECUTE_REBALANCE_ABI = [
  {
    type: 'function',
    name: 'executeRebalance',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      {
        name: 'steps',
        type: 'tuple[]',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'venue', type: 'address' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** `0xc52fc5da`。舊 ABI（A11 之前）的 selector 不同，那些交易解不出來，也本來就沒有 venue。 */
export const EXECUTE_REBALANCE_SELECTOR = toFunctionSelector(EXECUTE_REBALANCE_ABI[0]);

/**
 * 從一筆鏈上交易的 input 解出 `account` 那個帳戶這一輪的 steps；解不出來回 null。
 *
 * 那筆交易不是直接呼叫 executor：它是 bundler 送的 `EntryPoint.handleOps`，裡面包著 UserOp，
 * UserOp 的 callData 又是 Kernel 的 `execute`，最裡面才是 `executeRebalance`。
 * 這裡不逐層解，而是在整段 input 裡找 `executeRebalance` 的 selector，從那個位置直接解：
 *   - 外層怎麼包（EntryPoint 版本、Kernel 的 single／batch 模式）都不影響。
 *   - ABI 解碼只照 offset 讀，後面多出來的位元組（外層的 padding、其他 UserOp）會被忽略。
 *
 * 一定要比對 `account`：同一筆 bundle 可能包了別的帳戶的 UserOp，四個位元組也可能剛好撞到 selector。
 * 解碼失敗或帳戶不符就試下一個出現位置。
 */
export function decodeRebalanceSteps(input: string, account: string): RoutedStep[] | null {
  if (!/^0x[0-9a-fA-F]*$/.test(input) || !isAddress(account, { strict: false })) return null;
  const hex = input.slice(2).toLowerCase();
  const selector = EXECUTE_REBALANCE_SELECTOR.slice(2).toLowerCase();
  const wanted = account.toLowerCase();
  for (let at = hex.indexOf(selector); at !== -1; at = hex.indexOf(selector, at + 1)) {
    // selector 必須落在位元組邊界上（hex 的偶數位置）。
    if (at % 2 !== 0) continue;
    try {
      const decoded = decodeFunctionData({ abi: EXECUTE_REBALANCE_ABI, data: `0x${hex.slice(at)}` as Hex });
      const [target, steps] = decoded.args;
      if (target.toLowerCase() !== wanted) continue;
      return steps.map((step) => ({ tokenIn: step.tokenIn, tokenOut: step.tokenOut, venue: step.venue }));
    } catch {
      // 不是真的 executeRebalance calldata（剛好撞到四個位元組）→ 試下一個位置。
    }
  }
  return null;
}
