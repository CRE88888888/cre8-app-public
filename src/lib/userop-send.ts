/**
 * 廣播一個已準備好、已簽名的 UserOp（cre8-app#95 第三輪複審 R1）。
 *
 * 範圍（總管 2026-11-16）：這條「廣播前先算 hash」的新路徑只給生息（呼叫端帶 `onSubmitted`）而且是 chain 97。
 * 建立基金、批次授權、AccountControls 等其他呼叫者，以及 chain 56，一律走原本的 viem `sendUserOperation`（`sendUserOp` 的 legacy）。
 *
 * userOpHash 由 UserOp 內容、EntryPoint 與鏈決定，廣播前就算得出來。所以順序是：先把 hash 交給呼叫端存成「已送出待對帳」，
 * 再送 `eth_sendUserOperation`。送出時回應遺失、逾時、網路斷線，都可能其實已被 bundler 收下 → 原錯誤丟出、記錄留著，用原 hash 對帳。
 * 只有 bundler 明確回 JSON-RPC 錯誤（例如驗證失敗）才確定沒收 → 丟 `BundlerRejected`，呼叫端可以刪掉記錄、算沒送。
 */
import { BaseError, RpcRequestError } from 'viem';
import type { Hex } from 'viem';

export class BundlerRejected extends Error {
  readonly userOpHash: string;
  readonly cause: unknown;
  constructor(userOpHash: string, cause: unknown) {
    super((cause as Error)?.message ?? 'The bundler rejected the transaction.');
    this.name = 'BundlerRejected';
    this.userOpHash = userOpHash;
    this.cause = cause;
  }
}

/** bundler 有回應、而且是 JSON-RPC 錯誤（確定沒收下）。HTTP 失敗、逾時、斷線都不算。 */
export function isBundlerRejection(cause: unknown): boolean {
  if (cause instanceof RpcRequestError) return true;
  if (cause instanceof BaseError) return cause.walk((inner) => inner instanceof RpcRequestError) instanceof RpcRequestError;
  return false;
}

export async function broadcastPrepared(args: {
  userOpHash: Hex | string;
  onSubmitted?: ((userOpHash: Hex) => void) | undefined;
  broadcast: () => Promise<Hex>;
  isRejection?: (cause: unknown) => boolean;
}): Promise<Hex> {
  args.onSubmitted?.(args.userOpHash as Hex);
  try {
    return await args.broadcast();
  } catch (cause) {
    if ((args.isRejection ?? isBundlerRejection)(cause)) throw new BundlerRejected(args.userOpHash, cause);
    throw cause;
  }
}

/** 新路徑只開給 chain 97。 */
export const EARLY_HASH_CHAIN_ID = 97;

export function usesEarlyHash(chainId: number, onSubmitted: unknown): boolean {
  return onSubmitted !== undefined && chainId === EARLY_HASH_CHAIN_ID;
}

/**
 * 選路徑：生息＋chain 97 走 `early`（先算 hash、存、再廣播）；其他一律 `legacy`（原本的 `sendUserOperation`）。
 * legacy 時若有 `onSubmitted`（只會是非 97 的鏈），送出後才告訴它 hash，行為同 F5 之前。
 */
export async function sendUserOp(args: {
  chainId: number;
  onSubmitted?: ((userOpHash: Hex) => void) | undefined;
  legacy: () => Promise<Hex>;
  early: (onSubmitted: (userOpHash: Hex) => void) => Promise<Hex>;
}): Promise<Hex> {
  if (args.onSubmitted !== undefined && usesEarlyHash(args.chainId, args.onSubmitted)) return args.early(args.onSubmitted);
  const userOpHash = await args.legacy();
  args.onSubmitted?.(userOpHash);
  return userOpHash;
}
