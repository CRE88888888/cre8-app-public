import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, constants as zerodevConstants } from '@zerodev/sdk';
import { createPublicClient, http, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { RenewalParams } from './api.js';
import type { Trace } from './log.js';
import { chainFor, type WalletConnection } from './wallet.js';

/** canonical EntryPoint 位址；backend/src/addresses.ts 用的是 v0.7。 */
const ENTRY_POINT_V06 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const ENTRY_POINT_V07 = '0x0000000071727de22e5e9d8baf0edac6f37da032';

export type EntryPointPair = { address: Address; version: '0.6' | '0.7' };

/** 版本必須由位址決定：kernelVersion 0.3.3 在 EP0.6 與 EP0.7 都有，猜錯會 AA 一連串。 */
export function entryPointFromAddress(address: string): EntryPointPair {
  const lower = address.toLowerCase();
  if (lower === ENTRY_POINT_V06) return { address: address as Address, version: '0.6' };
  if (lower === ENTRY_POINT_V07) return { address: address as Address, version: '0.7' };
  throw new Error(
    `不認識的 entryPoint ${address}：既不是 canonical v0.6 (${ENTRY_POINT_V06}) 也不是 v0.7 (${ENTRY_POINT_V07})。請確認 renewal-params.entryPoint。`,
  );
}

/** 送出去的 UserOperation（EP0.7 形狀；undefined 欄位在送 RPC 前會剝掉）。 */
type UserOpRpc = {
  sender: Address;
  nonce: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  signature: Hex;
};

type EstimateResult = {
  callGasLimit?: Hex;
  verificationGasLimit?: Hex;
  preVerificationGas?: Hex;
  paymasterVerificationGasLimit?: Hex;
  paymasterPostOpGasLimit?: Hex;
};

type UserOpReceipt = {
  userOpHash: Hex;
  success: boolean;
  actualGasCost?: Hex;
  actualGasUsed?: Hex;
  reason?: string;
  receipt: { transactionHash: Hex; blockNumber: Hex; status?: Hex; gasUsed?: Hex };
};

export type RenewalOutcome = {
  userOpHash: Hex;
  txHash: Hex;
  receiptStatus: 'success' | 'reverted';
  signature: Hex;
  nonce: Hex;
  chainId: number;
  callData: Hex;
  gas: { callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex };
  fees: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
  userOpHashMatchesLocally: boolean;
  actualGasUsed?: Hex;
  actualGasCost?: Hex;
};

/**
 * bundler 的 JSON-RPC 走**後端 relay**：`POST {baseUrl}{path}`。
 *
 * 為什麼不是直連 bundler：alto v1.2.5 完全沒有 CORS 支援（`--help` 沒有相關選項，`OPTIONS` 回 404
 * 且不帶任何 `access-control-*`），所以瀏覽器直連一定被 preflight 擋掉 —— 這不是 dev 問題，
 * 生產環境一樣。後端已經有 CORS，由它代送即可。
 *
 * `renewal-params.bundlerUrl` 因此只是**資訊**（印在日誌上讓你知道後端打哪裡），不是 fetch 目標。
 */
export type BundlerRelay = { baseUrl: string; path: string; token: string };

/** 把 JSON-RPC 丟給後端 relay；錯誤原文整包往上丟（relay 原樣透傳 bundler 的 error）。 */
async function bundlerRpc<T>(relay: BundlerRelay, method: string, params: unknown[]): Promise<T> {
  const url = `${relay.baseUrl}${relay.path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${relay.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const raw = await res.text();
  if (!res.ok) {
    // 後端的錯誤是 {error:{code,message}}（403 BUNDLER_METHOD_NOT_ALLOWED／502 BUNDLER_UNAVAILABLE）。
    throw new Error(`bundler relay ${method} HTTP ${res.status}: ${raw}`);
  }
  let payload: { result?: T; error?: { code?: number; message?: string; data?: unknown } };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    throw new Error(`bundler ${method} 回應不是 JSON: ${raw}`);
  }
  if (payload.error) {
    throw new Error(
      `bundler ${method} 被拒絕: code=${payload.error.code} message=${payload.error.message} data=${JSON.stringify(payload.error.data)}`,
    );
  }
  if (payload.result === undefined) throw new Error(`bundler ${method} 沒有 result: ${raw}`);
  return payload.result;
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 等 userOp receipt：最多 60 次 × 2 秒 = 上限 120 秒。 */
async function waitForUserOperationReceipt(relay: BundlerRelay, userOpHash: Hex): Promise<UserOpReceipt> {
  const MAX_POLLS = 60;
  const INTERVAL_MS = 2_000;
  for (let i = 0; i < MAX_POLLS; i += 1) {
    try {
      const receipt = await bundlerRpc<UserOpReceipt | null>(relay, 'eth_getUserOperationReceipt', [userOpHash]);
      if (receipt) return receipt;
    } catch (err) {
      // receipt 還沒生成時有些 bundler 會回 error，不視為失敗，繼續等。
      if (i === MAX_POLLS - 1) throw err;
    }
    await sleep(INTERVAL_MS);
  }
  throw new Error(`等 userOp receipt 逾時（${MAX_POLLS} 次 × ${INTERVAL_MS}ms）`);
}

/**
 * 續期的核心：組 UserOp → 簽 → 送 bundler → 等 receipt。
 * 這裡刻意走「手寫 bundler JSON-RPC」而不是 createSmartAccountClient，
 * 因為每一步的中間值都要能被印出來驗證，而且不想被 SDK 的送出路徑藏掉 gas 參數。
 * 差別只在傳輸層：JSON-RPC 送的是後端 `/bundler` relay，不是 bundler 本人（它沒有 CORS）。
 */
export async function executeRenewal(input: {
  params: RenewalParams;
  wallet: WalletConnection;
  rpcUrl: string;
  /** 後端 relay（`POST {baseUrl}{path}`）：瀏覽器唯一能碰到 bundler 的路。 */
  bundlerRelay: BundlerRelay;
  expectedChainId: number;
  trace: Trace;
}): Promise<RenewalOutcome> {
  const { params, wallet, trace } = input;
  const accountAddress = params.accountAddress as Address;
  const entryPoint = entryPointFromAddress(params.entryPoint);

  trace.value('renewal-params.ownerAddress', params.ownerAddress);
  trace.value('renewal-params.accountAddress', accountAddress);
  trace.value('renewal-params.executorAddress', params.executorAddress);
  trace.value('renewal-params.entryPoint', `${params.entryPoint} → version ${entryPoint.version}`);
  trace.value('renewal-params.kernelVersion', params.kernelVersion);
  trace.value('renewal-params.sessionKeyAddress', params.sessionKeyAddress);
  trace.value('renewal-params.permissionId', params.permissionId);
  trace.value('renewal-params.keyRef', params.keyRef);
  trace.value('renewal-params.validUntil', params.validUntil);
  trace.value('renewal-params.expiresAt', params.expiresAt);
  // 只是資訊：前端不打這個位址（alto 沒有 CORS，瀏覽器直連一定被擋），實際打的是後端 relay。
  trace.value('renewal-params.bundlerUrl（資訊，非 fetch 目標）', params.bundlerUrl);
  trace.value('bundler relay（實際 fetch）', `${input.bundlerRelay.baseUrl}${input.bundlerRelay.path}`);
  trace.raw('renewal-params.initConfig', params.initConfig);
  trace.raw('renewal-params.policySnapshot', params.policySnapshot);

  // 1) 讀鏈上 chainId —— userOpHash 的 domain separator 含 chainId，必須用真實值。
  trace.step('讀 RPC chainId（決定 userOpHash 的 domain）');
  const rpcTransport = http(input.rpcUrl, { timeout: 30_000 });
  const chainId = await createPublicClient({ transport: rpcTransport }).getChainId();
  trace.ok(`RPC chainId = ${chainId}`);
  if (chainId !== input.expectedChainId) {
    trace.info(
      `注意：設定的 chainId=${input.expectedChainId} 與 RPC 實際 chainId=${chainId} 不同；以 RPC 為準（用設定的值簽會 AA24 signature error）。`,
    );
  }
  if (typeof params.chainId === 'number' && params.chainId !== chainId) {
    trace.info(`注意：renewal-params.chainId=${params.chainId} 與 RPC chainId=${chainId} 不同。`);
  }

  const chain = chainFor(chainId, input.rpcUrl);
  const publicClient: PublicClient = createPublicClient({ chain, transport: rpcTransport });

  // 2) sudo validator：signer 就是連線的錢包（注入錢包或 dev 私鑰）。
  trace.step('建立 ECDSA sudo validator（signer = 連線錢包）');
  const sudo = await signerToEcdsaValidator(publicClient, {
    signer: wallet.walletClient,
    entryPoint,
    // backend 釘死 0.3.3；型別要求字面量限制。
    kernelVersion: params.kernelVersion as '0.3.3',
  });
  trace.ok('sudo validator', { address: sudo.address, validatorType: sudo.validatorType, source: sudo.source });
  trace.value('signer（錢包地址）', wallet.address);
  if (sudo.address && wallet.address && params.ownerAddress) {
    const ownerMatches = wallet.address.toLowerCase() === params.ownerAddress.toLowerCase();
    trace.info(
      ownerMatches
        ? 'owner 檢查：連線錢包 == renewal-params.ownerAddress ✔'
        : `owner 檢查：連線錢包 ${wallet.address} != renewal-params.ownerAddress ${params.ownerAddress} —— 除非這是 sudo owner 代理登入，否則簽章會過不了驗證`,
    );
  }

  // 3) Kernel account：用 address 短路推導（重算需要當初的 initConfig）。
  trace.step('createKernelAccount（address 短路，不重算 counterfactual）');
  const kernel = await createKernelAccount(publicClient, {
    address: accountAddress,
    plugins: { sudo },
    entryPoint,
    kernelVersion: params.kernelVersion as '0.3.3',
  });
  trace.ok('kernel account', { address: await kernel.getAddress(), kernelVersion: kernel.kernelVersion, entryPoint: entryPoint.version });

  // 4) calls：renewal-params.initConfig 的兩筆 calldata。
  const calls = params.initConfig.map((data) => ({ to: accountAddress, data: data as Hex }));
  trace.value('calls 數量', calls.length);
  calls.forEach((c, i) => trace.value(`calls[${i}]`, { to: c.to, data: c.data }));
  const callData = await kernel.encodeCalls(calls);
  trace.value('callData（kernel.encodeCalls 的產物）', callData);

  // 5) nonce（用 kernel 的 nonce key，不是 entryPoint 的預設 key）。
  trace.step('讀 account nonce');
  const nonce = await kernel.getNonce();
  const nonceHex = toHex(nonce);
  trace.ok('nonce', `${nonce.toString()} (${nonceHex})`);

  // 6) 費用（EP0.7 的 userOp 要自己帶 maxFeePerGas / maxPriorityFeePerGas）。
  trace.step('取 maxFeePerGas / maxPriorityFeePerGas');
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  try {
    fees = await publicClient.estimateFeesPerGas();
    trace.ok('estimateFeesPerGas');
  } catch (err) {
    trace.fail('estimateFeesPerGas', err);
    const gasPrice = await publicClient.getGasPrice();
    fees = { maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice };
    trace.info('改用 getGasPrice()：maxFeePerGas = gasPrice*2, maxPriorityFeePerGas = gasPrice');
  }
  const feesHex = {
    maxFeePerGas: toHex(fees.maxFeePerGas),
    maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
  };
  trace.value('fees', { ...feesHex, maxFeePerGasWei: fees.maxFeePerGas.toString() });

  // 7) 估 gas：對 bundler 打 eth_estimateUserOperationGas，簽章位置擺 dummy。
  trace.step('eth_estimateUserOperationGas（bundler）');
  const estimateRequest = {
    sender: accountAddress,
    nonce: nonceHex,
    callData,
    ...feesHex,
    signature: zerodevConstants.DUMMY_ECDSA_SIG,
  };
  let gas: RenewalOutcome['gas'];
  try {
    const estimate = await bundlerRpc<EstimateResult>(input.bundlerRelay, 'eth_estimateUserOperationGas', [
      stripUndefined(estimateRequest),
      entryPoint.address,
    ]);
    trace.ok('eth_estimateUserOperationGas', estimate);
    gas = {
      callGasLimit: estimate.callGasLimit ?? toHex(500_000n),
      verificationGasLimit: estimate.verificationGasLimit ?? toHex(1_000_000n),
      preVerificationGas: estimate.preVerificationGas ?? toHex(100_000n),
    };
    if (!estimate.callGasLimit || !estimate.verificationGasLimit || !estimate.preVerificationGas) {
      trace.info('bundler 少回某些 gas 欄位，缺的用保守預設值補上（上面已印原始回應）。');
    }
  } catch (err) {
    trace.fail('eth_estimateUserOperationGas', err);
    gas = { callGasLimit: toHex(500_000n), verificationGasLimit: toHex(1_000_000n), preVerificationGas: toHex(100_000n) };
    trace.info('估算失敗，改用保守預設值繼續（這只是讓流程能往下走，不代表能上鏈）：' + JSON.stringify(gas));
  }
  trace.value('gas', {
    callGasLimit: `${gas.callGasLimit} (${BigInt(gas.callGasLimit)})`,
    verificationGasLimit: `${gas.verificationGasLimit} (${BigInt(gas.verificationGasLimit)})`,
    preVerificationGas: `${gas.preVerificationGas} (${BigInt(gas.preVerificationGas)})`,
  });

  // 8) 組 op 並簽名 —— 這一步就是 Kernel 的驗證模式 B（EIP-191 personal_sign）。
  const userOp: UserOpRpc = {
    sender: accountAddress,
    nonce: nonceHex,
    callData,
    callGasLimit: gas.callGasLimit,
    verificationGasLimit: gas.verificationGasLimit,
    preVerificationGas: gas.preVerificationGas,
    ...feesHex,
    signature: '0x',
  };

  trace.step('kernel.signUserOperation（內部走 ECDSA validator 的 personal_sign）');
  // kernel account 與 plugin manager 都有簽名入口；優先帳戶層的。
  const kernelLike = kernel as unknown as {
    signUserOperation?: (op: Record<string, unknown>) => Promise<Hex>;
    kernelPluginManager?: { signUserOperation?: (op: Record<string, unknown>) => Promise<Hex> };
  };
  const signFn =
    kernelLike.signUserOperation?.bind(kernelLike) ??
    kernelLike.kernelPluginManager?.signUserOperation?.bind(kernelLike.kernelPluginManager);
  if (!signFn) throw new Error('kernel account 找不到 signUserOperation（SDK 版本不符？）');
  const signature = await signFn({ ...userOp, chainId });
  trace.ok('userOp signature', signature);
  trace.info(`signature 長度 ${(signature.length - 2) / 2} bytes（65 = 單一 ECDSA，Kernel sudo 模式不加 validator 前綴）`);

  const signedUserOp: UserOpRpc = { ...userOp, signature };

  // 9) 本地算一次 userOpHash，和 bundler 回傳的對照。
  const localUserOpHash = getUserOperationHash({
    userOperation: { ...signedUserOp, signature: '0x' } as unknown as UserOperation<'0.7'>,
    entryPointAddress: entryPoint.address,
    entryPointVersion: entryPoint.version,
    chainId,
  });
  trace.value('userOpHash（本地 viem 計算）', localUserOpHash);
  trace.raw('送出前的完整 userOp', signedUserOp);

  // 10) 送 bundler。
  trace.step('eth_sendUserOperation（bundler）');
  const userOpHash = await bundlerRpc<Hex>(input.bundlerRelay, 'eth_sendUserOperation', [signedUserOp, entryPoint.address]);
  trace.ok('eth_sendUserOperation', userOpHash);
  const userOpHashMatchesLocally = userOpHash.toLowerCase() === localUserOpHash.toLowerCase();

  // 11) 等 userOp receipt → transactionHash。
  trace.step('eth_getUserOperationReceipt（最多 60 × 2s）');
  const userOpReceipt = await waitForUserOperationReceipt(input.bundlerRelay, userOpHash);
  trace.ok('userOp receipt', {
    success: userOpReceipt.success,
    reason: userOpReceipt.reason,
    actualGasUsed: userOpReceipt.actualGasUsed,
    actualGasCost: userOpReceipt.actualGasCost,
    transactionHash: userOpReceipt.receipt.transactionHash,
    blockNumber: userOpReceipt.receipt.blockNumber,
  });

  // 12) 等鏈上 receipt。
  trace.step('publicClient.waitForTransactionReceipt');
  const receipt = await publicClient.waitForTransactionReceipt({ hash: userOpReceipt.receipt.transactionHash });
  trace.ok('transaction receipt', { status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });

  return {
    userOpHash,
    txHash: userOpReceipt.receipt.transactionHash,
    receiptStatus: receipt.status,
    signature,
    nonce: nonceHex,
    chainId,
    callData,
    gas,
    fees: feesHex,
    userOpHashMatchesLocally,
    actualGasUsed: userOpReceipt.actualGasUsed,
    actualGasCost: userOpReceipt.actualGasCost,
  };
}
