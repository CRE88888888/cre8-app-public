/**
 * 加息策略（backend `strategy-earn`）的 owner UserOp：後端回的 `calls` 原樣送，App 不重組、不改內容。
 * 同一組 endpoint 由 v1 或路由 v2 回答，形狀相同（backend docs/strategy-earn-routing-v2.zh-TW.md）。
 *
 * - `authorization: 'renewal_required'`（`auto`，路由 v2 的 `open` 也會回）：最新的 session key 還不能替這個帳戶做加息的動作。
 *   把續期（`GET /portfolios/:id/renewal-params` 的 `initConfig`，帳戶對自己呼叫）接在同一筆最前面，一起簽；上鏈後記回後端。
 *   不帶的話排程器之後沒有權限，賣出前的還款會卡住。
 * - `close` 的 `exit: true`（只有路由 v2 會用）：全部退出時，激勵代幣一併送到 owner 錢包。單純關掉加息不帶，激勵留在組合帳戶。
 */
import type { Address, Hex } from 'viem';

/** 後端回的一筆 call（`value` 是十進位字串）。 */
export type EarnCall = { to: Address; data: Hex; value: string; gas?: string };
/** 帳戶 owner 簽的一筆 call（`sendSudoCalls`）。 */
export type OwnerCall = { to: Address; data: Hex; value: bigint };

export const needsRenewal = (quote: { authorization?: unknown }): boolean => quote.authorization === 'renewal_required';

/** 一筆 owner UserOp 的 calls：有續期就放最前面（對帳戶自己、value 0），後面是後端的 calls，順序與內容不變。 */
export function ownerCalls(account: Address, calls: readonly EarnCall[], renewal: { initConfig: readonly string[] } | null): OwnerCall[] {
  return [
    ...(renewal === null ? [] : renewal.initConfig.map((data) => ({ to: account, data: data as Hex, value: 0n }))),
    ...calls.map((call) => ({ to: call.to, data: call.data, value: BigInt(call.value || '0') })),
  ];
}

/**
 * 送一筆後端報價的 owner UserOp。報價要求續期時先拿續期參數、同一筆送出，成功後才記回後端；
 * 不要求（v1 的 `open`、`close`、已經有權限）就只送 calls，不多讀任何東西。`send` 失敗（丟出）時不記續期。
 */
export async function sendWithRenewal<P extends { initConfig: readonly string[] }, R>(args: {
  account: Address;
  quote: { authorization?: unknown; calls: readonly EarnCall[] };
  renewalParams: () => Promise<P>;
  send: (calls: OwnerCall[]) => Promise<R>;
  recordRenewal: (params: P) => Promise<void>;
}): Promise<R> {
  const renewal = needsRenewal(args.quote) ? await args.renewalParams() : null;
  const result = await args.send(ownerCalls(args.account, args.quote.calls, renewal));
  if (renewal !== null) await args.recordRenewal(renewal);
  return result;
}

/** `POST /portfolios/:id/strategy-earn/close` 的 body：開著的資產一次交給後端；`exit` 只在全部退出時帶。 */
export function closeRequest(assets: readonly string[], exit = false): { assets: string[]; exit?: true } {
  return exit ? { assets: [...assets], exit: true } : { assets: [...assets] };
}
