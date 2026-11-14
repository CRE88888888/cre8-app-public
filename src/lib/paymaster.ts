/**
 * 平台代付 gas（測試網，cre8-app#62）。純邏輯：不 fetch、不碰 React。
 *
 * 後端（backend#68）的 `POST /paymaster/sponsor` 收一筆 **v0.7 packed UserOperation**，核對白名單、額度與
 * paymaster 存款後，回傳簽好的 `paymasterAndData`（效期最多 300 秒）。帳戶自己不需要原生代幣。
 *
 * viem 送 UserOp 的順序：`getPaymasterStubData`（估 gas 用的假資料）→ 估 gas → `getPaymasterData`
 * （gas 欄位都定了，才向後端要真正的簽名）。後端只在第二步記額度，所以第一步不可以打後端。
 * 這兩個 hook 的組裝與後端自己的排程器相同（backend `src/paymaster.ts` 的 `schedulerPaymaster`）。
 */
import { concatHex, encodeAbiParameters, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import { ApiError } from './api';

/** 送給 `/paymaster/sponsor` 的 UserOp。整數用十進位字串（後端也收 hex）。 */
export type PackedSponsorOperation = {
  sender: Address;
  nonce: string;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: string;
  gasFees: Hex;
  paymasterAndData: '0x';
  signature: '0x';
};

export type UnpackedOperation = {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  factory?: Address | undefined;
  factoryData?: Hex | undefined;
  callGasLimit?: bigint | undefined;
  verificationGasLimit?: bigint | undefined;
  preVerificationGas?: bigint | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
};

/**
 * viem 的 UserOp（欄位分開）→ EntryPoint v0.7 的 packed 形狀。
 * gas 欄位還沒估出來就丟錯：那代表被拿去估 gas 的階段呼叫了，而那個階段不可以向後端要簽名。
 */
export function packForSponsorship(op: UnpackedOperation): PackedSponsorOperation {
  const { callGasLimit, verificationGasLimit, preVerificationGas, maxFeePerGas, maxPriorityFeePerGas } = op;
  if (
    callGasLimit === undefined || verificationGasLimit === undefined || preVerificationGas === undefined ||
    maxFeePerGas === undefined || maxPriorityFeePerGas === undefined
  ) {
    throw new Error('The transaction is not fully prepared yet (gas is missing), so sponsorship cannot be requested.');
  }
  return {
    sender: op.sender,
    nonce: op.nonce.toString(),
    initCode: op.factory ? concatHex([op.factory, op.factoryData ?? '0x']) : '0x',
    callData: op.callData,
    accountGasLimits: concatHex([toHex(verificationGasLimit, { size: 16 }), toHex(callGasLimit, { size: 16 })]),
    preVerificationGas: preVerificationGas.toString(),
    gasFees: concatHex([toHex(maxPriorityFeePerGas, { size: 16 }), toHex(maxFeePerGas, { size: 16 })]),
    paymasterAndData: '0x',
    signature: '0x',
  };
}

/** 後端預設的 paymaster gas 上限（`PAYMASTER_VERIFICATION_GAS_LIMIT`＝100000、`PAYMASTER_POST_OP_GAS_LIMIT`＝0）。只給估 gas 用。 */
const STUB_VERIFICATION_GAS = 100_000n;
const STUB_POST_OP_GAS = 0n;

/**
 * 估 gas 用的假 paymaster 資料：長度與真的一樣（uint48 效期 ×2 ＋ 65 bytes 簽名），簽名是固定的假值，
 * 對任何真的 UserOp 都無效。真正的資料在 `getPaymasterData` 才向後端要。
 */
export function stubPaymasterData(paymaster: Address): {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
} {
  return {
    paymaster,
    paymasterVerificationGasLimit: STUB_VERIFICATION_GAS,
    paymasterPostOpGasLimit: STUB_POST_OP_GAS,
    paymasterData: concatHex([
      encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [0, 0]),
      `0x${'11'.repeat(64)}1b`,
    ]),
  };
}

/** `/paymaster/sponsor` 的回應裡前端用得到的欄位。兩個 gas 上限是 hex 字串。 */
export type SponsorResponse = {
  paymaster: string;
  paymasterData: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  validUntil: number;
};

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/** 回應 → viem 要的形狀。paymaster 必須是地址簿上的那一個，否則不用（不讓錯的後端設定換掉付款方）。 */
export function sponsorshipFromResponse(body: SponsorResponse, expectedPaymaster: Address): {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
} {
  if (typeof body.paymaster !== 'string' || body.paymaster.toLowerCase() !== expectedPaymaster.toLowerCase()) {
    throw new SponsorshipError('PAYMASTER_ADDRESS_MISMATCH', `server paymaster ${String(body.paymaster)} ≠ address book ${expectedPaymaster}`);
  }
  if (typeof body.paymasterData !== 'string' || !HEX.test(body.paymasterData)) {
    throw new SponsorshipError('PAYMASTER_BAD_RESPONSE', 'paymasterData is not hex');
  }
  try {
    return {
      paymaster: expectedPaymaster,
      paymasterData: body.paymasterData as Hex,
      paymasterVerificationGasLimit: BigInt(body.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: BigInt(body.paymasterPostOpGasLimit),
    };
  } catch {
    throw new SponsorshipError('PAYMASTER_BAD_RESPONSE', 'gas limits are not numbers');
  }
}

const NOT_SENT = 'Nothing was sent.';
/** 每一句都要讓使用者知道：費用是平台付的，不是要他自己去補原生代幣。 */
const NO_TOP_UP = 'You do not need to add BNB yourself.';

/**
 * 代付被拒時給使用者看的一句話。依後端的代碼（`PAYMASTER_*`）決定；認不出來給通用的一句。
 *
 * - 額度用完（429 `PAYMASTER_QUOTA_EXCEEDED`）：帳戶每日次數／金額，或全站每日金額，後端不分。
 * - 白名單外（403 `PAYMASTER_CALL_FORBIDDEN`）：這個動作不在代付範圍。
 * - 押金不足（503 `PAYMASTER_DEPOSIT_INSUFFICIENT`）：平台的 paymaster 存款不夠，是我們這邊的事。
 */
export function explainSponsorFailure(code: string, status: number): string {
  if (code === 'PAYMASTER_QUOTA_EXCEEDED') {
    return `Today’s free network-fee allowance is used up. ${NOT_SENT} It resets tomorrow (UTC). ${NO_TOP_UP}`;
  }
  if (code === 'PAYMASTER_CALL_FORBIDDEN') {
    return `This action is not covered by CRE8’s free network fees on the testnet yet. ${NOT_SENT} ${NO_TOP_UP}`;
  }
  if (code === 'PAYMASTER_DEPOSIT_INSUFFICIENT') {
    return `CRE8’s network-fee fund for the testnet needs a top-up on our side. ${NOT_SENT} Please try again later. ${NO_TOP_UP}`;
  }
  if (/^PAYMASTER_(SENDER_FORBIDDEN|ACCOUNT_|FACTORY_)/.test(code)) {
    return `This account is not set up for free network fees. ${NOT_SENT} ${NO_TOP_UP}`;
  }
  if (/^PAYMASTER_(EXPIRED|RESERVATION_CONFLICT|INVALID_OPERATION|BAD_RESPONSE)$/.test(code)) {
    return `The network-fee approval could not be prepared in time. ${NOT_SENT} Please try again.`;
  }
  if (status === 401) return `Your session has expired. ${NOT_SENT} Sign in again, then retry.`;
  if (status === 429) return `Too many requests. ${NOT_SENT} Wait a minute, then try again.`;
  // 斷線用代碼判斷，不用 status：前端自己產生的錯誤（例如地址不符）沒有 HTTP 狀態，不可以被說成斷線。
  if (code === 'NETWORK') return `CRE8 could not be reached. ${NOT_SENT} Check your connection, then try again.`;
  // PAYMASTER_DISABLED、…_UNAVAILABLE、CHAIN_MISMATCH、CONFIGURATION_MISMATCH、ADDRESS_MISMATCH 與其他。
  return `Free network fees are not available right now. ${NOT_SENT} Please try again later. ${NO_TOP_UP}`;
}

/**
 * 代付沒拿到。`message` 是白話英文，`technical` 是狀態碼與後端原文（收進可展開的細節）。
 * `ErrorNote` 認得它，不會顯示成「Unexpected error」。
 */
export class SponsorshipError extends Error {
  readonly code: string;
  readonly technical: string;
  readonly title = 'Network fee not covered';
  constructor(code: string, detail: string, status = 0) {
    super(explainSponsorFailure(code, status));
    this.name = 'SponsorshipError';
    this.code = code;
    this.technical = `${status === 0 ? '' : `${status} · `}${code}\n${detail}`;
  }

  static from(cause: unknown): SponsorshipError {
    if (cause instanceof SponsorshipError) return cause;
    if (cause instanceof ApiError) return new SponsorshipError(cause.status === 0 ? 'NETWORK' : cause.code, cause.message, cause.status);
    return new SponsorshipError('PAYMASTER_BAD_RESPONSE', cause instanceof Error ? cause.message : String(cause));
  }
}
