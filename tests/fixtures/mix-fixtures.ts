/**
 * My mix 的範例回應（cre8-app#132）：形狀照 backend `docs/my-mix.zh-TW.md` 與 backend#179 的 API 範例。
 * 只給測試用；App 本身一律打真的 API。地址是 chain 97 的 NVDAB／TSLAB、registry、USDT。
 */
import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { REGISTRY_ABI } from "../../src/lib/atp-contracts";

export const NVDAB = "0x5d63b93e50ef9f8851e1de71d8255c2f0beab397";
export const TSLAB = "0x587cb8fe057344490a28390c7986e1beff5ad36e";
export const REGISTRY = "0x7ff384fC959bf70fF7b2f011C6A84a36244264EA";
/** 改比例時被移除、還沒賣完的舊資產（測試用地址）。 */
export const SELL_ONLY = "0x2222222222222222222222222222222222222222";
export const EXECUTOR = "0xB65Ec2EC6f5aB0a345b50cAA454cf792C1EF2bB9";
export const USDT = "0x1111111111111111111111111111111111111111";
export const ACCOUNT = "0x8ac8258516d8f4298b1d7629867dd22121e672ed";
/** 最後一筆 enroll 的鏈上 strategy id（後端 `mix-approval.ts` 用 onchainId，和回應裡資料庫的 strategyId 不同）。 */
export const ONCHAIN_ID = 123n;

export const approveData = (spender: string, amount: bigint = maxUint256) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as `0x${string}`, amount] });
export const transferData = (to: string, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, amount] });
export const enrollData = (account: string = ACCOUNT, id: bigint = ONCHAIN_ID, version = 1) =>
  encodeFunctionData({ abi: REGISTRY_ABI, functionName: "enroll", args: [account as `0x${string}`, id, version] });

/** `POST /me/mixes` 201。 */
export const CREATED = {
  mixId: 7,
  strategyId: 42,
  account: ACCOUNT,
  signingMode: "sudo",
  expectedVersion: 1,
  nonce: "18446744073709551616",
  expiresAt: "2026-11-21T10:15:00.000Z",
  calls: [
    { to: NVDAB, value: "0", data: approveData(EXECUTOR) },
    { to: TSLAB, value: "0", data: approveData(EXECUTOR) },
    { to: REGISTRY, value: "0", data: enrollData() },
  ],
  intentId: "11",
  message: "確認後立即套用新比例；收盤中的股票會在開盤時交易。",
  name: "My tech",
  shareCode: "aiBitcoinMix0000000000001",
};

/** `GET /me/mixes/:id`。 */
export const DETAIL = {
  id: 7,
  name: "My tech",
  assets: [{ assetId: NVDAB, weightBps: 6000 }, { assetId: TSLAB, weightBps: 4000 }],
  rebalance: { frequency: "monthly", startDate: "2026-11-21" },
  createdAt: "2026-11-21T10:00:00.000Z",
  exit: { takeProfitBps: 3000, stopLossBps: 2000 },
  shareCode: "aiBitcoinMix0000000000001",
  account: ACCOUNT,
  portfolioId: 90,
  strategyId: 42,
  status: "active",
  pendingChange: false,
  currentValueRaw: "130000000000000000000",
  netInputRaw: "100000000000000000000",
  returnBps: "3000",
  performanceInputRaw: "100000000000000000000",
  performanceStartedAt: "2026-11-21T10:00:00.000Z",
  valuedAt: "2026-11-21T10:05:00.000Z",
  performanceMessage: null,
  nextRebalanceAt: "2026-12-21T00:00:00.000Z",
  residualCash: null,
  markets: [{ assetId: NVDAB, open: false, nextOpenAt: "2026-11-21T14:30:00.000Z" }],
  selling: [],
  events: [{ id: "3", at: "2026-11-21T10:01:00.000Z", kind: "mix_enrolled", message: "組合已建立。" }],
} as const;

/** 後端 My mix 會回的錯誤碼（backend main `src/` 裡的 AppError／ValidationError）。 */
export const BACKEND_CODES = [
  "INVALID_MIX", "INVALID_MIX_FREQUENCY", "MIX_CHAIN_UNAVAILABLE", "MIX_BUSY", "INVALID_MIX_EXIT", "INVALID_MIX_DATE",
  "INVALID_MIX_ASSETS", "MIX_UNAVAILABLE", "MIX_PREVIEW_UNAVAILABLE", "MIX_CREATE_BUSY", "MIX_ASSET_LIMIT", "INVALID_MIX_PROOF",
  "INVALID_MIX_PREVIEW", "UNAUTHORIZED", "TOO_MANY_ASSETS", "RATE_LIMITED", "MIX_SWITCH_PENDING", "MIX_REQUEST_CONFLICT",
  "MIX_PREVIEW_TIMEOUT", "MIX_PREVIEW_BUSY", "MIX_NO_PENDING_CHANGE", "MIX_NOT_FOUND", "MIX_NOT_EXITED", "MIX_HISTORY_UNAVAILABLE",
  "INVALID_MIX_WEIGHT", "INVALID_MIX_TOTAL", "INVALID_MIX_REQUEST_KEY", "INVALID_MIX_NAME", "INVALID_MIX_IMPORT", "INVALID_MIX_ASSET",
] as const;
