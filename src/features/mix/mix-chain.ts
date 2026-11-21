/**
 * My mix 的鏈上步驟（cre8-app#132）：簽後端準備好的 owner UserOp、確認、把 USDT 放進組合帳戶並記成入金、領回 USDT。
 *
 * 簽名：`POST /me/mixes`（或 PATCH 改成分）回 `calls`（必要的新資產 approve＋最後一筆 enroll）與完整 `nonce`。
 * App 照原樣用帳戶 owner 簽一個 sudo UserOp（經既有 sponsor 與 `POST /bundler`），nonce 用後端給的。
 * 簽之前把每一筆 calldata 解碼核對（C3 審查 #133 第 4 點）：
 * - 前面只能是 `approve(executor, max)`，目標是目錄裡的資產或 USDT；
 * - 最後一筆必須是 registry 的 `enroll(payload.account, id, 1)`，而且鏈上這個 id 的第 1 版就是用戶挑的資產與比例；
 * - 其他函式一律不簽。
 * 不重組 calls——sponsor 只代付後端存下的那一組。上鏈後 `POST /me/mixes/:id/confirm`；確認不到也沒關係，
 * 後端的排程與明細查詢會自己找 Enrolled 對帳。
 *
 * 入金（審查第 1 點）：USDT 進帳戶之後，一定要 `POST /portfolios/:portfolioId/funding-lots` 記成這個組合的投入，
 * 後端才會買（排程要求可用現金＝鏈上 USDT，否則 MIX_CASH_RECONCILIATION 不買）。記帳失敗的來源存在 localStorage，
 * 組合頁打開時補記，不會因為重按 Add money 而多轉一次錢。
 */
import { useQuery } from '@tanstack/react-query';
import { createWalletClient, custom, decodeFunctionData, encodeFunctionData, erc20Abi, http, maxUint256, type Address, type Hex } from 'viem';
import { ApiError, postFaucetUsdt, postFundingLot, postGasFaucet } from '../../lib/api';
import { REGISTRY_ABI } from '../../lib/atp-contracts';
import { faucetFailure } from '../../lib/faucet';
import { waitForAccountCode } from '../../lib/first-enroll';
import { CHAIN, assertRpcChain, bsc as appChain, publicClientFor, readOnlyClient, readRpcUrl, sendSudoCalls, sendWithdraw, transferCalldata, type RenewalWallet } from '../../lib/kernel';
import { ensureOwnerGas } from '../../lib/testnet-wallet-buy';
import { MIX_CATALOG } from './mix-catalog';
import { mixApi } from './mix-api';
import type { MixAsset, MixSigningPayload } from './mix-types';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const ERC20_BALANCE = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const lower = (value: string) => value.toLowerCase();

/** 後端回的簽名資料不對：不簽、不送。 */
export class MixPayloadError extends Error {
  readonly code = 'MIX_PAYLOAD_INVALID';
  constructor(readonly field: string) {
    super(`signing payload: ${field}`);
    this.name = 'MixPayloadError';
  }
}

/** 核對 calls 用的地址：registry、executor，以及可以 approve 的資產（目錄 40 個＋USDT）。 */
export type MixCallBook = { registry: string; executor: string; assets: Set<string> };

export function mixCallBook(): MixCallBook {
  const contracts = CHAIN.contracts;
  return {
    registry: lower(contracts?.registry ?? ''),
    executor: lower(contracts?.executor ?? ''),
    assets: new Set([...(contracts === null ? [] : [contracts.usdt]), ...MIX_CATALOG.map((asset) => asset.address)].map(lower)),
  };
}

/** 核對過的簽名資料，外加最後一筆 enroll 的鏈上 strategy id（和 payload 的 `strategyId` 是後端資料庫的 id，兩者不同）。 */
export type CheckedPayload = MixSigningPayload & { onchainId: bigint };

/** 核對後端的簽名資料：形狀、每一筆 calldata 解碼後的函式與參數。不改內容。 */
export function checkSigningPayload(body: unknown, book: MixCallBook = mixCallBook()): CheckedPayload {
  if (typeof body !== 'object' || body === null) throw new MixPayloadError('body');
  const p = body as Record<string, unknown>;
  if (!Number.isSafeInteger(p.mixId) || (p.mixId as number) <= 0) throw new MixPayloadError('mixId');
  if (!Number.isSafeInteger(p.strategyId) || (p.strategyId as number) <= 0) throw new MixPayloadError('strategyId');
  if (typeof p.account !== 'string' || !ADDRESS.test(p.account)) throw new MixPayloadError('account');
  if (p.signingMode !== 'sudo') throw new MixPayloadError('signingMode');
  if (p.expectedVersion !== 1) throw new MixPayloadError('expectedVersion');
  if (typeof p.nonce !== 'string' || !/^\d{1,78}$/.test(p.nonce)) throw new MixPayloadError('nonce');
  if (!Array.isArray(p.calls) || p.calls.length === 0 || p.calls.length > 12) throw new MixPayloadError('calls');
  if (book.registry === '' || book.executor === '') throw new MixPayloadError('address book');
  const calls = p.calls as unknown[];
  let onchainId: bigint | null = null;
  calls.forEach((call, index) => {
    const c = call as Record<string, unknown> | null;
    if (c === null || typeof c.to !== 'string' || !ADDRESS.test(c.to)) throw new MixPayloadError('calls.to');
    if (c.value !== '0') throw new MixPayloadError('calls.value');
    if (typeof c.data !== 'string' || !HEX.test(c.data) || c.data.length < 10) throw new MixPayloadError('calls.data');
    const last = index === calls.length - 1;
    if (last) {
      // 最後一筆：registry 的 enroll(帳戶, id, 1)。
      if (lower(c.to) !== book.registry) throw new MixPayloadError('enroll.to');
      const decoded = decodeOrNull(REGISTRY_ABI, c.data as Hex);
      if (decoded?.functionName !== 'enroll') throw new MixPayloadError('enroll.function');
      const [account, id, version] = decoded.args as readonly [string, bigint, number];
      if (lower(account) !== lower(p.account as string)) throw new MixPayloadError('enroll.account');
      if (id <= 0n) throw new MixPayloadError('enroll.id');
      if (version !== 1) throw new MixPayloadError('enroll.version');
      onchainId = id;
      return;
    }
    // 其餘：目錄資產或 USDT 的 approve(executor, max)。
    if (!book.assets.has(lower(c.to))) throw new MixPayloadError('approve.to');
    const decoded = decodeOrNull(erc20Abi, c.data as Hex);
    if (decoded?.functionName !== 'approve') throw new MixPayloadError('approve.function');
    const [spender, amount] = decoded.args as readonly [string, bigint];
    if (lower(spender) !== book.executor) throw new MixPayloadError('approve.spender');
    if (amount !== maxUint256) throw new MixPayloadError('approve.amount');
  });
  if (onchainId === null) throw new MixPayloadError('enroll');
  return { ...(p as unknown as MixSigningPayload), onchainId };
}

function decodeOrNull<const Abi extends readonly unknown[]>(abi: Abi, data: Hex) {
  try {
    const decoded = decodeFunctionData({ abi: abi as never, data }) as { functionName: string; args: readonly unknown[] };
    // 再編碼一次要和原 data 完全一樣：多塞尾巴或不標準編碼的 calldata 不簽。
    const again = (encodeFunctionData as (input: unknown) => Hex)({ abi, functionName: decoded.functionName, args: decoded.args });
    return lower(again) === lower(data) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * 鏈上這個 id 的第 1 版要就是用戶挑的那一組（審查第 4 點的「strategy 等於回傳值」）：
 * 用戶挑的每一個都在、比例相同。多出來的只能是：
 * - USDT 0 bp：後端每個 mix 都會加這一筆（backend `mix-domain.ts` 的 `mixChainAllocation`；合約允許 numeraire 權重為 0）；
 * - 改比例時「只賣不買」的舊資產，各 1 bp，從最大的成分扣。
 */
export function versionMatchesPicks(
  onchain: { assets: readonly string[]; weightsBps: readonly number[] },
  picks: readonly MixAsset[],
  numeraire: string = CHAIN.contracts?.usdt ?? '',
): boolean {
  if (onchain.assets.length !== onchain.weightsBps.length) return false;
  const chain = new Map(onchain.assets.map((asset, index) => [lower(asset), onchain.weightsBps[index] ?? 0]));
  const wanted = new Map(picks.map((pick) => [lower(pick.assetId), pick.weightBps]));
  const extras = [...chain.entries()].filter(([asset]) => !wanted.has(asset));
  const cash = lower(numeraire);
  if (extras.some(([asset, weight]) => !(weight === 1 && asset !== cash) && !(asset === cash && weight === 0))) return false;
  const sellOnly = extras.filter(([, weight]) => weight === 1).length;
  for (const [asset, weight] of wanted) {
    const actual = chain.get(asset);
    if (actual === undefined || Math.abs(actual - weight) > sellOnly) return false;
  }
  return true;
}

async function assertEnrollTarget(onchainId: bigint, picks: readonly MixAsset[] | undefined): Promise<void> {
  const registry = CHAIN.contracts?.registry as Address | undefined;
  if (registry === undefined) throw new MixPayloadError('address book');
  let version: { assets: readonly string[]; weightsBps: readonly number[] };
  try {
    version = await readOnlyClient().readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'version', args: [onchainId, 1] }) as never;
  } catch {
    throw new MixPayloadError('enroll.strategy unreadable');
  }
  const catalog = mixCallBook().assets;
  if (version.assets.length === 0 || version.assets.some((asset) => !catalog.has(lower(asset)))) throw new MixPayloadError('enroll.strategy assets');
  if (picks !== undefined && !versionMatchesPicks(version, picks)) throw new MixPayloadError('enroll.strategy picks');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type MixStage = 'sign' | 'confirm' | 'fund';

/**
 * 簽後端準備好的那一組 calls，上鏈後請後端確認。`picks`：用戶這次挑的資產與比例（建立、Change mix）；
 * 從組合頁的 Finish 補簽時不知道新比例，只核對鏈上資產都在目錄裡。
 * 回傳 `portfolioId`：後端已經建好（null＝還在對帳，稍後明細會自己更新）。
 */
export async function signMix(args: {
  wallet: RenewalWallet;
  token: string;
  payload: unknown;
  picks?: readonly MixAsset[];
  onStage?: (stage: MixStage) => void;
  wait?: (ms: number) => Promise<void>;
}): Promise<{ mixId: number; account: Address; portfolioId: number | null }> {
  const payload = checkSigningPayload(args.payload);
  const account = payload.account as Address;
  const wait = args.wait ?? sleep;
  args.onStage?.('sign');
  await assertEnrollTarget(payload.onchainId, args.picks);
  await waitForAccountCode((address) => readOnlyClient().getCode({ address }), account);
  const receipt = await sendSudoCalls({
    wallet: args.wallet,
    token: args.token,
    accountAddress: account,
    // 帳戶已部署、地址明確傳入，這個 id 只用來推導 factory 參數（不會送出）；改成分時是新的 strategy 也沒關係。
    strategyId: payload.strategyId,
    calls: payload.calls.map((call) => ({ to: call.to as Address, data: call.data as Hex, value: 0n })),
    nonce: BigInt(payload.nonce as string),
  });
  if (!receipt.success) throw new ApiError(0, 'MIX_SIGNED_REVERTED', `reverted: ${receipt.txHash}`);
  args.onStage?.('confirm');
  // RPC 慢一兩個塊時後端還看不到收據：重試幾次，還是不行就交給後端自己對帳。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const confirmed = await mixApi.confirm(args.token, payload.mixId, receipt.txHash);
      return { mixId: payload.mixId, account, portfolioId: Number.isSafeInteger(confirmed.portfolioId) ? confirmed.portfolioId : null };
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.code !== 'MIX_BUSY') break;
      await wait(3_000);
    }
  }
  return { mixId: payload.mixId, account, portfolioId: null };
}

/**
 * 建立的回應裡 calls 是空的（第一次的意圖超過 15 分鐘已過期，或其實已經確認過）：重讀 enrollment-params。
 * 回 null＝已經確認過，不用再簽。
 */
export async function freshCreationPayload(token: string, created: MixSigningPayload): Promise<MixSigningPayload | null> {
  if (created.calls.length > 0) return created;
  try {
    return await mixApi.prepare(token, created.mixId);
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'MIX_NO_PENDING_CHANGE') return null;
    throw cause;
  }
}

/* ── 入金 ─────────────────────────────────────── */

export type MixFundingSource = { kind: 'wallet_transfer'; txHash: string } | { kind: 'faucet_claim'; claimId: string };
const PENDING_KEY = 'cre8.mixFunding.v1';
/**
 * 待補記的入金用 mixId 當 key（`m:<mixId>`）：改比例確認後 portfolioId 會換，補記時送最新的那個。
 * 舊版用 portfolioId 當 key（純數字），讀的時候搬過來。
 */
const mixKey = (mixId: number) => `m:${mixId}`;

function readPending(): Record<string, MixFundingSource[]> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PENDING_KEY) ?? '{}') as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, MixFundingSource[]> : {};
  } catch {
    return {};
  }
}
function writePending(all: Record<string, MixFundingSource[]>): void {
  try { window.localStorage.setItem(PENDING_KEY, JSON.stringify(all)); } catch { /* 存不了就只靠這次的重試。 */ }
}
const sameSource = (a: MixFundingSource, b: MixFundingSource) => a.kind === b.kind && (a.kind === 'wallet_transfer' ? a.txHash === (b as typeof a).txHash : a.claimId === (b as typeof a).claimId);
const merge = (list: MixFundingSource[], more: MixFundingSource[]) => [...list, ...more.filter((item) => !list.some((have) => sameSource(have, item)))];

/** 這個組合待補記的入金。`legacyPortfolioId`：舊版以 portfolioId 存的那一份，一起搬到 mixId 底下。 */
export function pendingMixFunding(mixId: number, legacyPortfolioId: number | null = null): MixFundingSource[] {
  const all = readPending();
  if (legacyPortfolioId !== null && all[String(legacyPortfolioId)] !== undefined) {
    all[mixKey(mixId)] = merge(all[mixKey(mixId)] ?? [], all[String(legacyPortfolioId)] ?? []);
    delete all[String(legacyPortfolioId)];
    writePending(all);
  }
  return all[mixKey(mixId)] ?? [];
}
function rememberFunding(mixId: number, source: MixFundingSource): void {
  const all = readPending();
  all[mixKey(mixId)] = merge(all[mixKey(mixId)] ?? [], [source]);
  writePending(all);
}
function forgetFunding(mixId: number, source: MixFundingSource): void {
  const all = readPending();
  const list = (all[mixKey(mixId)] ?? []).filter((item) => !sameSource(item, source));
  if (list.length === 0) delete all[mixKey(mixId)];
  else all[mixKey(mixId)] = list;
  writePending(all);
}

/** 收據還沒被後端的 RPC 看到、後端忙、改比例還沒確認、網路斷：值得再試。 */
function fundingRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.status === 0 || error.status >= 500) return true;
  return ['FUNDING_NOT_CONFIRMED', 'PORTFOLIO_BUSY', 'MIX_BUSY', 'MIX_SWITCH_PENDING'].includes(error.code);
}

/** 不能再試的（來源不屬於這個組合、已被改比例承接等）：不留著，免得每次打開組合頁都重送。 */
function fundingSettled(error: unknown): boolean {
  return error instanceof ApiError && ['FUNDING_EVENT_CONFLICT', 'MIX_FUNDING_ALREADY_CARRIED', 'INVALID_FUNDING_SOURCE'].includes(error.code);
}

/**
 * 把這筆入金記成組合的投入（`POST /portfolios/:portfolioId/funding-lots`）。同一個來源重送不會重記。
 * 先存起來（以 mixId 為 key）再送；記好才刪。回 true＝記好了。
 */
export async function recordMixFunding(args: {
  token: string;
  mixId: number;
  portfolioId: number;
  source: MixFundingSource;
  attempts?: number;
  wait?: (ms: number) => Promise<void>;
  post?: typeof postFundingLot;
}): Promise<boolean> {
  const { token, mixId, portfolioId, source, attempts = 6, wait = sleep, post = postFundingLot } = args;
  rememberFunding(mixId, source);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await post(token, portfolioId, source);
      forgetFunding(mixId, source);
      return true;
    } catch (cause) {
      if (fundingSettled(cause)) { forgetFunding(mixId, source); return true; }
      if (!fundingRetryable(cause) || attempt === attempts - 1) return false;
      await wait(3_000);
    }
  }
  return false;
}

/** 組合頁打開時：上次沒記好的入金，用目前的 portfolioId 補記。回補記好的筆數。 */
export async function settlePendingMixFunding(token: string, mixId: number, portfolioId: number, options: { post?: typeof postFundingLot } = {}): Promise<number> {
  let settled = 0;
  for (const source of pendingMixFunding(mixId, portfolioId)) {
    if (await recordMixFunding({ token, mixId, portfolioId, source, attempts: 2, ...options })) settled += 1;
  }
  return settled;
}

/** 錢包裡的 USDT（18 位小數）。讀不到回 null。 */
export async function readWalletUsdt(owner: string): Promise<bigint | null> {
  const usdt = CHAIN.contracts?.usdt;
  if (usdt === undefined || !ADDRESS.test(owner)) return null;
  try {
    return await readOnlyClient().readContract({ address: usdt as Address, abi: ERC20_BALANCE, functionName: 'balanceOf', args: [owner as Address] });
  } catch {
    return null;
  }
}

/** 錢包 → 組合帳戶轉 USDT。測試網錢包沒 tBNB 時先請後端補（同基金頁）。回交易 hash（之後記成入金）。 */
export async function sendUsdtToMix(args: { wallet: RenewalWallet; token: string; account: Address; amount: bigint }): Promise<Hex> {
  const usdt = CHAIN.contracts?.usdt as Address | undefined;
  if (usdt === undefined) throw new ApiError(0, 'MIX_CHAIN_UNAVAILABLE', 'no USDT on this chain');
  await assertRpcChain();
  if (CHAIN.faucetFunded) {
    const reader = publicClientFor(args.wallet);
    await ensureOwnerGas({
      readBalance: () => reader.getBalance({ address: args.wallet.address as Address }),
      requestGas: () => postGasFaucet(args.token),
      waitForTx: async (hash) => { await reader.waitForTransactionReceipt({ hash: hash as Hex, timeout: 30_000 }); },
    });
  }
  const data = transferCalldata(args.account, args.amount);
  let hash: Hex;
  if (args.wallet.kind === 'dev') {
    const rpcUrl = readRpcUrl();
    if (rpcUrl === undefined || rpcUrl === '') throw new Error('dev mode needs VITE_RPC_URL');
    hash = await createWalletClient({ account: args.wallet.account, chain: appChain, transport: http(rpcUrl) }).sendTransaction({ to: usdt, data, chain: appChain });
  } else {
    hash = await createWalletClient({ account: args.wallet.address as Address, chain: appChain, transport: custom(args.wallet.provider as never) })
      .sendTransaction({ to: usdt, data, chain: appChain });
  }
  const receipt = await publicClientFor(args.wallet).waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new ApiError(0, 'MIX_TRANSFER_REVERTED', `reverted: ${hash}`);
  return hash;
}

/** 測試網：把今天的 1,000 測試 USDT 直接領進組合帳戶（帳戶要先確認好，後端才認得）。回 claimId（之後記成入金）。 */
export async function claimTestUsdtToMix(token: string, account: Address): Promise<string> {
  let body: Awaited<ReturnType<typeof postFaucetUsdt>>;
  try {
    body = await postFaucetUsdt(token, account);
  } catch (cause) {
    throw new ApiError(cause instanceof ApiError ? cause.status : 0, 'MIX_FAUCET_FAILED', faucetFailure(cause).message);
  }
  if (typeof body.claimId !== 'string' || body.claimId === '') throw new ApiError(0, 'MIX_FAUCET_FAILED', faucetFailure(null).message);
  // 等那筆 mint 上鏈，後端才讀得到收據。
  if (typeof body.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    await readOnlyClient().waitForTransactionReceipt({ hash: body.txHash as Hex, timeout: 60_000 }).catch(() => undefined);
  }
  return body.claimId;
}

/**
 * 放錢進組合（錢包轉帳或測試 USDT），再記成入金。回 `recorded`：false＝錢已進帳戶、還沒記好（組合頁會補記）。
 */
export async function fundMix(args: {
  wallet: RenewalWallet;
  token: string;
  account: Address;
  mixId: number;
  portfolioId: number;
  with: { kind: 'wallet'; amount: bigint } | { kind: 'test-usdt' };
}): Promise<{ recorded: boolean }> {
  const source: MixFundingSource = args.with.kind === 'test-usdt'
    ? { kind: 'faucet_claim', claimId: await claimTestUsdtToMix(args.token, args.account) }
    : { kind: 'wallet_transfer', txHash: await sendUsdtToMix({ wallet: args.wallet, token: args.token, account: args.account, amount: args.with.amount }) };
  return { recorded: await recordMixFunding({ token: args.token, mixId: args.mixId, portfolioId: args.portfolioId, source }) };
}

/** 組合帳戶裡的 USDT（退出後全是 USDT）。 */
export async function readMixUsdt(account: string): Promise<bigint | null> {
  return readWalletUsdt(account);
}

/** 把組合帳戶裡的 USDT 全部領回自己的錢包（owner 簽；後端只代付「USDT 轉回本人」）。 */
export async function withdrawMixUsdt(args: { wallet: RenewalWallet; token: string; account: Address; strategyId: number; amount: bigint }): Promise<void> {
  const usdt = CHAIN.contracts?.usdt as Address | undefined;
  if (usdt === undefined) throw new ApiError(0, 'MIX_CHAIN_UNAVAILABLE', 'no USDT on this chain');
  const receipt = await sendWithdraw({
    wallet: args.wallet, token: args.token, accountAddress: args.account, asset: usdt,
    recipient: args.wallet.address as Address, amountWei: args.amount, strategyId: args.strategyId,
  });
  if (!receipt.success) throw new ApiError(0, 'MIX_TRANSFER_REVERTED', `reverted: ${receipt.txHash}`);
}

/** 錢包 USDT 餘額（Buy 頁判斷要轉錢包的錢還是領測試 USDT）。 */
export function useWalletUsdt(owner: string | null | undefined) {
  return useQuery({
    queryKey: ['mix-wallet-usdt', owner ?? ''],
    queryFn: () => readWalletUsdt(owner ?? ''),
    enabled: typeof owner === 'string' && ADDRESS.test(owner),
    staleTime: 15_000,
  });
}
