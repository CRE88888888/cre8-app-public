/**
 * ATP 合約（registry、executor）在前端用得到的那一小塊：ABI、calldata、唯讀查詢（cre8-app#29，A10 配合）。
 *
 * 來源是 cre8-contracts 的 `src/atp/AtpRegistry.sol` 與 `src/atp/AtpExecutor.sol`（A10：#12、#13、#14；
 * P11 版本通知期：cre8-contracts#54，`docs/versioning-p11.zh-TW.md`，PR head de69a89）。
 * 這裡只抄前端真的會呼叫的函式，簽章改了要跟著改。
 *
 * P11 重點：新版本至少 24 小時後才生效（只調低績效費可立即）、同時只有一個待生效版本、可在生效前取消、
 * 兩次發版至少隔 7 天。帳戶自動跟隨最新**已生效**版本；`enrollments(account).version` 只是本人當時接受的版本。
 * 舊的二參數 `enroll` 已移除；帳戶本人用 sudo 呼叫三參數 `enroll`（app 第一次買入就這樣做，`firstEnrollCalls`）即同意
 * `FOLLOW_VERSIONS_TERMS`。session key 的權限不能包含 registry（見 `SESSION_KEY_FORBIDDEN_SELECTORS`）。
 *
 * 兩件要記得的事：
 * 1. **registry 的位址後端沒有給**，但 executor 上有 `registry()`（immutable）。所以一律從
 *    `PortfolioStatus.executorAddress` 出發再問鏈。
 * 2. **A10 之前的合約沒有這些函式**（`globalPaused`、`buyAllowance`、`pauseFlags`）。舊合約上
 *    呼叫會 revert，這裡一律接住回 `null`，代表「這個部署沒有這個功能／現在讀不到」，
 *    呼叫端看到 `null` 就不顯示，不可以當成 false 或 0。
 */
import { encodeFunctionData, erc20Abi, maxUint256, toFunctionSelector } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { readChainId } from './chain-config';
import type { OnchainVersion } from './fund-versions';

/**
 * P11 合約（七欄 Version、三參數 enroll）只在 chain 97；chain 56 仍是舊合約（四欄 Version、二參數 enroll），
 * 用 `LEGACY_REGISTRY_ABI`（審查 #95 第 3 項）。下面的函式都收一個 `p11` 參數，預設照這次 build 的鏈。
 */
export const P11_REGISTRY = readChainId(import.meta.env.VITE_CHAIN_ID) === 97;

/** chain 56 的舊 registry（P11 之前）：與 main 上的 ABI 相同。 */
export const LEGACY_REGISTRY_ABI = [
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

export const REGISTRY_ABI = [
  {
    type: 'function', name: 'enroll', stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'expectedVersion', type: 'uint16' }], outputs: [],
  },
  { type: 'function', name: 'approveEnrollment', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint256' }, { name: 'expectedVersion', type: 'uint16' }], outputs: [] },
  { type: 'function', name: 'revokeEnrollmentApproval', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'cancelVersion', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'pendingVersion', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'versionCount', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'lastPublishedAt', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'historicalAssets', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: 'assets', type: 'address[]' }] },
  { type: 'function', name: 'wasAssetAllowed', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }, { name: 'asset', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'isEnrolled', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'enrollmentApproval', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'FOLLOW_VERSIONS_TERMS', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'event', name: 'VersionScheduled', inputs: [{ name: 'id', type: 'uint256', indexed: true }, { name: 'version', type: 'uint16', indexed: true }, { name: 'activeAt', type: 'uint64', indexed: false }, { name: 'configHash', type: 'bytes32', indexed: false }] },
  { type: 'event', name: 'VersionCancelled', inputs: [{ name: 'id', type: 'uint256', indexed: true }, { name: 'version', type: 'uint16', indexed: true }] },
  { type: 'event', name: 'EnrollmentApproved', inputs: [{ name: 'account', type: 'address', indexed: true }, { name: 'id', type: 'uint256', indexed: true }, { name: 'version', type: 'uint16', indexed: false }, { name: 'terms', type: 'bytes32', indexed: false }] },
  { type: 'event', name: 'Enrolled', inputs: [{ name: 'account', type: 'address', indexed: true }, { name: 'id', type: 'uint256', indexed: false }, { name: 'version', type: 'uint16', indexed: false }] },
  { type: 'function', name: 'setPaused', stateMutability: 'nonpayable', inputs: [{ name: 'account', type: 'address' }, { name: 'paused', type: 'bool' }], outputs: [] },
  {
    type: 'function', name: 'enrollments', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'tuple', components: [{ name: 'strategyId', type: 'uint256' }, { name: 'version', type: 'uint16' }, { name: 'paused', type: 'bool' }] }],
  },
  { type: 'function', name: 'pauseFlags', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'activeVersion', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'uint16' }] },
  {
    type: 'function', name: 'version', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }, { name: 'versionNumber', type: 'uint16' }],
    outputs: [{
      name: '', type: 'tuple',
      components: [
        { name: 'assets', type: 'address[]' }, { name: 'weightsBps', type: 'uint16[]' }, { name: 'scheduleHash', type: 'bytes32' }, { name: 'activeAt', type: 'uint64' },
        // P11 追加在原四欄之後。
        { name: 'settingsHash', type: 'bytes32' }, { name: 'performanceFeeBps', type: 'uint16' }, { name: 'configHash', type: 'bytes32' },
      ],
    }],
  },
] as const;

/** 新版本最短等多久才生效（秒）：合約 `VERSION_DELAY`。 */
export const VERSION_DELAY_SECONDS = 24 * 60 * 60;
/** 兩次發版最短間隔（秒）：合約 `PUBLICATION_INTERVAL`；取消的版本也算。 */
export const PUBLICATION_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 帳戶本人同意跟隨之後版本的條款（合約 `FOLLOW_VERSIONS_TERMS` 是這段英文的 keccak256，逐字不能改）。
 * 畫面顯示白話版 `FOLLOW_VERSIONS_PLAIN`，原文收在細節裡。
 */
export const FOLLOW_VERSIONS_TERMS_TEXT =
  'I agree to follow future strategy versions; changes require at least 24 hours notice during which I can exit. Fee-only decreases may take effect immediately.';
/** keccak256(FOLLOW_VERSIONS_TERMS_TEXT)，與合約常數相同（測試核對）。 */
export const FOLLOW_VERSIONS_TERMS_HASH = '0x6a09d1b304dde687ed21179a03e0d452399a5027a2a5c6bf1d95e545cffa776e';

/** 同意條款的白話版（畫面上看的）。 */
export const FOLLOW_VERSIONS_PLAIN = {
  follow: 'If the creator changes the fund’s settings later, your account follows the new version automatically. A new version is announced at least 24 hours before it takes effect, and you can exit during that time if you don’t agree.',
  feeCut: 'Only a lower performance fee can take effect right away.',
} as const;

/** 下單面板上預設看得到的那一句（點開才看完整白話版與簽名原文）。 */
export const FOLLOW_VERSIONS_SHORT = 'Fund updates apply automatically, with 24h notice to exit.';

/**
 * session key 絕對不能拿到的 registry 函式（P11）：加入、同意都要帳戶本人（owner 簽的 sudo UserOp）。
 * 前端不組 session key 的 CallPolicy（後端組），這份清單給檢查用：`assertSessionPolicySafe`。
 */
export const SESSION_KEY_FORBIDDEN_FUNCTIONS = ['enroll', 'approveEnrollment', 'revokeEnrollmentApproval'] as const;

const FORBIDDEN_SIGNATURES: Record<string, string> = {
  'enroll(address,uint256,uint16)': 'enroll',
  // 舊合約的二參數 enroll：也不能給。
  'enroll(address,uint256)': 'enroll',
  'approveEnrollment(uint256,uint16)': 'approveEnrollment',
  'revokeEnrollmentApproval()': 'revokeEnrollmentApproval',
};

/**
 * 續期要裝的 session key 設定（後端給的 `initConfig`）裡有沒有 registry 的加入／同意函式的 selector。
 * 有就不簽（回傳找到的函式名）。CallPolicy 把允許的 selector 原樣編進安裝資料，所以直接找 4 bytes。
 */
export function forbiddenSessionGrants(initConfig: readonly string[]): string[] {
  const data = initConfig.map((item) => item.toLowerCase().replace(/^0x/, '')).join(' ');
  const found = new Set<string>();
  for (const [signature, name] of Object.entries(FORBIDDEN_SIGNATURES)) {
    if (data.includes(toFunctionSelector(signature).slice(2))) found.add(name);
  }
  return [...found];
}

export const EXECUTOR_ABI = [
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'globalPaused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  {
    type: 'function', name: 'buyAllowance', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'cap', type: 'uint256' }, { name: 'bought', type: 'uint256' }, { name: 'windowEndsAt', type: 'uint64' }],
  },
] as const;

/**
 * `registry.enroll(account, id, expectedVersion)` 的 calldata（P11 三參數；二參數版已移除）。
 *
 * 帳戶自己呼叫（owner 簽的 sudo UserOp）＝同意 `FOLLOW_VERSIONS_TERMS`。`expectedVersion` 必須是當下最新
 * **已生效**的版本（`activeVersion`），不然 revert（`UnexpectedVersion`）：建立者不能趁送出前換版。
 * 會**清掉所有暫停**。
 */
export function enrollCalldata(account: Address, strategyOnchainId: bigint, expectedVersion: number, p11: boolean = P11_REGISTRY): Hex {
  // chain 56 的舊合約只有二參數 enroll（釘當下最新版）。
  if (!p11) return encodeFunctionData({ abi: LEGACY_REGISTRY_ABI, functionName: 'enroll', args: [account, strategyOnchainId] });
  return encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [account, strategyOnchainId, expectedVersion] });
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

/** 帳戶要執行的一筆呼叫（owner 簽的 sudo UserOp 裡的一項）。 */
export type AccountCall = { to: Address; data: Hex; value: bigint };

/**
 * 升版要送的呼叫（cre8-app#50）：`registry.enroll(account, id)`，加上**新版本多出來的資產**各一筆
 * `approve(executor, max)`，全部放在同一個 UserOp，使用者簽一次。
 *
 * 為什麼要一起 approve：executor 是用 `transferFrom` 從帳戶拿代幣去換的。新版本多了一個資產、
 * 帳戶卻沒有授權它的話，升版會成功，但下一輪再平衡會被後端的前置檢查擋下（allowance 不足），
 * 使用者得另外再簽一筆。
 *
 * - 「新資產」＝在 `latest` 裡、不在 `current` 裡的位址（不分大小寫、不重複）。權重是 0 的也算：
 *   它在這個版本的資產清單裡，executor 就可能要動它。
 * - 沒有新資產時只有 `enroll` 一筆。
 * - 兩份配置必須是**剛從鏈上讀到的**：`enroll` 釘的是送出當下的最新版本，不是畫面上那一版。
 */
export function upgradeCalls(args: {
  registry: Address;
  executor: Address;
  account: Address;
  strategyOnchainId: bigint;
  /** P11：要接受的版本＝目前最新已生效版本（`activeVersion`）。 */
  expectedVersion: number;
  current: OnchainAllocation;
  latest: OnchainAllocation;
  /** 預設照這次 build 的鏈（chain 56 用舊的二參數 enroll）。 */
  p11?: boolean;
}): { calls: AccountCall[]; newAssets: Address[] } {
  const held = new Set(args.current.map((row) => row.asset.toLowerCase()));
  const newAssets: Address[] = [];
  for (const row of args.latest) {
    const key = row.asset.toLowerCase();
    if (held.has(key)) continue;
    held.add(key);
    newAssets.push(row.asset);
  }
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [args.executor, maxUint256] });
  return {
    calls: [
      { to: args.registry, data: enrollCalldata(args.account, args.strategyOnchainId, args.expectedVersion, args.p11 ?? P11_REGISTRY), value: 0n },
      ...newAssets.map((asset) => ({ to: asset, data: approve, value: 0n })),
    ],
    newAssets,
  };
}

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

async function readAllocation(client: PublicClient, registry: Address, id: bigint, version: number, p11: boolean): Promise<OnchainAllocation> {
  // 舊合約的 Version 只有四欄：用七欄的 ABI 解會 IntegerOutOfRangeError（審查 #95 第 3 項）。
  const row = p11
    ? await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'version', args: [id, version] })
    : await client.readContract({ address: registry, abi: LEGACY_REGISTRY_ABI, functionName: 'version', args: [id, version] });
  return row.assets.map((asset, index) => ({ asset, weightBps: Number(row.weightsBps[index] ?? 0) }));
}

/** 這個帳戶在鏈上實際 enroll 的策略、版本、配置與暫停狀態。讀不到會丟錯（由呼叫端決定怎麼顯示）。 */
export async function readOnchainAccount(client: PublicClient, executor: Address, account: Address, p11: boolean = P11_REGISTRY): Promise<OnchainAccount> {
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
  const current = await readAllocation(client, registry, enrollment.strategyId, enrollment.version, p11);
  const latest =
    latestVersion === enrollment.version || latestVersion === 0
      ? current
      : await readAllocation(client, registry, enrollment.strategyId, latestVersion, p11);
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

/** 一檔策略在鏈上的版本排程（P11）：目前生效版、待生效版（沒有就 null）、上次發版時間、曾經生效的全部資產。 */
export type VersionSchedule = {
  registry: Address;
  strategyId: bigint;
  active: OnchainVersion | null;
  pending: OnchainVersion | null;
  /** unix 秒；0 = 沒發過。 */
  lastPublishedAt: number;
  historicalAssets: Address[];
};

async function readVersion(client: PublicClient, registry: Address, id: bigint, versionNumber: number): Promise<OnchainVersion> {
  const row = await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'version', args: [id, versionNumber] });
  return {
    version: versionNumber,
    assets: row.assets.map((asset, index) => ({ asset, weightBps: Number(row.weightsBps[index] ?? 0) })),
    activeAt: Number(row.activeAt),
    settingsHash: row.settingsHash,
    performanceFeeBps: Number(row.performanceFeeBps),
    configHash: row.configHash,
  };
}

/** 讀版本排程。讀不到會丟錯（舊合約沒有 `pendingVersion`），由呼叫端當成「不知道」。 */
export async function readVersionSchedule(client: PublicClient, registry: Address, id: bigint): Promise<VersionSchedule> {
  const [activeNumber, pendingNumber, lastPublishedAt, historicalAssets] = await Promise.all([
    client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'activeVersion', args: [id] }),
    client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'pendingVersion', args: [id] }),
    client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'lastPublishedAt', args: [id] }),
    client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'historicalAssets', args: [id] }),
  ]);
  const [active, pending] = await Promise.all([
    Number(activeNumber) === 0 ? null : readVersion(client, registry, id, Number(activeNumber)),
    Number(pendingNumber) === 0 ? null : readVersion(client, registry, id, Number(pendingNumber)),
  ]);
  return { registry, strategyId: id, active, pending, lastPublishedAt: Number(lastPublishedAt), historicalAssets: [...historicalAssets] };
}

/** 這檔還沒有生效版本（第一版也要等 24 小時）：不能加入。 */
export class FundNotOpenError extends Error {
  constructor() {
    super('This fund has no settings in effect yet, so it can’t be joined. Nothing was sent.');
    this.name = 'FundNotOpenError';
  }
}

/** 後端接受的版本和鏈上現在的不一樣（剛好換版了）：不簽、不送。 */
export class EnrollVersionChangedError extends Error {
  constructor() {
    super('The fund’s settings changed while you were joining, so nothing was sent. Please try again.');
    this.name = 'EnrollVersionChangedError';
  }
}

/**
 * 第一次買入（加入基金）要由帳戶本人送的呼叫（P11，cre8-contracts#54）：一個 owner 簽的 sudo UserOp，只有兩筆——
 * `enroll(account, id, 後端接受的版本)`（＝同意 `FOLLOW_VERSIONS_TERMS`）與 USDT 的 `approve(executor, max)`。
 * 後端的代付只收這兩種（審查 #95 第 2 項）；其他資產的授權等 enrollment-confirm 建好投組後，走買入流程裡既有的分批授權。
 * 帳戶一定已由後端先部署（不帶 initCode）。不用 `approveEnrollment`、不經 operator；session key 不碰 registry。
 *
 * 簽名前核對（審查 #95 第 5 項）：鏈上目前生效版必須就是後端接受的 `expectedVersion`，那一版的 `configHash` 也要相同；
 * 不同丟 `EnrollVersionChangedError`。已經加入同一策略的這一版：回 null（跳過）。鏈上還沒有生效版本：丟 `FundNotOpenError`。
 */
export async function firstEnrollCalls(
  client: PublicClient,
  args: { registry: Address; executor: Address; usdt: Address; account: Address; id: bigint; expectedVersion: number; configHash: Hex },
): Promise<AccountCall[] | null> {
  const { registry, executor, usdt, account, id, expectedVersion, configHash } = args;
  const [enrollment, activeNumber] = await Promise.all([
    client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'enrollments', args: [account] }),
    client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'activeVersion', args: [id] }),
  ]);
  const active = Number(activeNumber);
  if (active === 0) throw new FundNotOpenError();
  if (active !== expectedVersion) throw new EnrollVersionChangedError();
  const row = await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'version', args: [id, active] });
  if (row.configHash.toLowerCase() !== configHash.toLowerCase()) throw new EnrollVersionChangedError();
  if (enrollment.version !== 0 && enrollment.strategyId === id && Number(enrollment.version) === active) return null;
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [executor, maxUint256] });
  return [
    { to: registry, data: enrollCalldata(account, id, active, true), value: 0n },
    { to: usdt, data: approve, value: 0n },
  ];
}
