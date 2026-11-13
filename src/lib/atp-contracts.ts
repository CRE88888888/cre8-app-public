/**
 * ATP 合約（registry、executor）在前端用得到的那一小塊：ABI、calldata、唯讀查詢（cre8-app#29，A10 配合）。
 *
 * 來源是 cre8-contracts 的 `src/atp/AtpRegistry.sol` 與 `src/atp/AtpExecutor.sol`（A10：#12、#13、#14）。
 * 這裡只抄前端真的會呼叫的函式，簽章改了要跟著改。
 *
 * 兩件要記得的事：
 * 1. **registry 的位址後端沒有給**，但 executor 上有 `registry()`（immutable）。所以一律從
 *    `PortfolioStatus.executorAddress` 出發再問鏈。
 * 2. **A10 之前的合約沒有這些函式**（`globalPaused`、`buyAllowance`、`pauseFlags`）。舊合約上
 *    呼叫會 revert，這裡一律接住回 `null`，代表「這個部署沒有這個功能／現在讀不到」，
 *    呼叫端看到 `null` 就不顯示，不可以當成 false 或 0。
 */
import { encodeFunctionData } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';

export const REGISTRY_ABI = [
  { type: 'function', name: 'enroll', stateMutability: 'nonpayable', inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setPaused', stateMutability: 'nonpayable', inputs: [{ name: 'account', type: 'address' }, { name: 'paused', type: 'bool' }], outputs: [] },
  {
    type: 'function', name: 'enrollments', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'tuple', components: [{ name: 'strategyId', type: 'uint256' }, { name: 'version', type: 'uint16' }, { name: 'paused', type: 'bool' }] }],
  },
  { type: 'function', name: 'pauseFlags', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'activeVersion', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'uint16' }] },
  {
    type: 'function', name: 'version', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }, { name: 'versionNumber', type: 'uint16' }],
    outputs: [{ name: '', type: 'tuple', components: [{ name: 'assets', type: 'address[]' }, { name: 'weightsBps', type: 'uint16[]' }, { name: 'scheduleHash', type: 'bytes32' }, { name: 'activeAt', type: 'uint64' }] }],
  },
] as const;

export const EXECUTOR_ABI = [
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'globalPaused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  {
    type: 'function', name: 'buyAllowance', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'cap', type: 'uint256' }, { name: 'bought', type: 'uint256' }, { name: 'windowEndsAt', type: 'uint64' }],
  },
] as const;

/**
 * `registry.enroll(account, id)` 的 calldata。
 *
 * 帳戶自己呼叫（owner 簽的 sudo UserOp）時永遠被允許：第一次 enroll、升到最新版本、換策略都是這一筆。
 * 它會把帳戶釘在該策略**目前最新發布的版本**，並且**清掉所有暫停**。
 */
export function enrollCalldata(account: Address, strategyOnchainId: bigint): Hex {
  return encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [account, strategyOnchainId] });
}

/**
 * `registry.setPaused(account, paused)` 的 calldata。
 *
 * 帳戶自己呼叫時：`true` 只設「自己暫停」那一格；`false` 會**清掉所有來源**的暫停
 * （包括 Safe 與平台設的），所以恢復之前要先讓使用者知道別人為什麼暫停。
 */
export function setPausedCalldata(account: Address, paused: boolean): Hex {
  return encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'setPaused', args: [account, paused] });
}

export type OnchainAllocation = { asset: Address; weightBps: number }[];

export type OnchainAccount = {
  registry: Address;
  /** 鏈上釘住的策略（registry 的 id）。`version === 0` 代表這個帳戶還沒 enroll。 */
  strategyId: bigint;
  version: number;
  paused: boolean;
  /** 暫停來源的位元旗標（1 = Safe、2 = 平台 operator、4 = 帳戶自己）。`null` = 舊合約沒有這個欄位。 */
  pauseFlags: number | null;
  /** 這個策略目前最新發布的版本。 */
  latestVersion: number;
  /** 帳戶現在釘住的那一版的配置；還沒 enroll 時為 null。 */
  current: OnchainAllocation | null;
  /** 最新版的配置；與 `current` 同一版時就是同一份。 */
  latest: OnchainAllocation | null;
};

async function readAllocation(client: PublicClient, registry: Address, id: bigint, version: number): Promise<OnchainAllocation> {
  const row = await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'version', args: [id, version] });
  return row.assets.map((asset, index) => ({ asset, weightBps: Number(row.weightsBps[index] ?? 0) }));
}

/** 這個帳戶在鏈上實際 enroll 的策略、版本、配置與暫停狀態。讀不到會丟錯（由呼叫端決定怎麼顯示）。 */
export async function readOnchainAccount(client: PublicClient, executor: Address, account: Address): Promise<OnchainAccount> {
  const registry = await client.readContract({ address: executor, abi: EXECUTOR_ABI, functionName: 'registry' });
  const enrollment = await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'enrollments', args: [account] });
  const pauseFlags = await client
    .readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'pauseFlags', args: [account] })
    .then((flags) => Number(flags))
    .catch(() => null);
  if (enrollment.version === 0) {
    return { registry, strategyId: enrollment.strategyId, version: 0, paused: false, pauseFlags, latestVersion: 0, current: null, latest: null };
  }
  const latestVersion = Number(
    await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'activeVersion', args: [enrollment.strategyId] }),
  );
  const current = await readAllocation(client, registry, enrollment.strategyId, enrollment.version);
  const latest =
    latestVersion === enrollment.version || latestVersion === 0
      ? current
      : await readAllocation(client, registry, enrollment.strategyId, latestVersion);
  return {
    registry,
    strategyId: enrollment.strategyId,
    version: enrollment.version,
    paused: enrollment.paused,
    pauseFlags,
    latestVersion,
    current,
    latest,
  };
}

/** `executor.globalPaused()`。`null` = 舊合約沒有這個函式，或現在讀不到。 */
export function readGlobalPaused(client: PublicClient, executor: Address): Promise<boolean | null> {
  return client
    .readContract({ address: executor, abi: EXECUTOR_ABI, functionName: 'globalPaused' })
    .then((paused) => paused)
    .catch(() => null);
}

export type BuyAllowance = { cap: bigint; bought: bigint; windowEndsAt: number };

/** `executor.buyAllowance(account)`（單位是 USDT 最小單位；`windowEndsAt` 是 unix 秒，0 = 沒有開著的窗口）。`null` 同上。 */
export function readBuyAllowance(client: PublicClient, executor: Address, account: Address): Promise<BuyAllowance | null> {
  return client
    .readContract({ address: executor, abi: EXECUTOR_ABI, functionName: 'buyAllowance', args: [account] })
    .then(([cap, bought, windowEndsAt]) => ({ cap, bought, windowEndsAt: Number(windowEndsAt) }))
    .catch(() => null);
}
