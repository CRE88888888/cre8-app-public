/**
 * P11 首次加入（chain 97）的順序（總管 2026-11-16 更正，backend#126）：
 *
 * 1. `POST /portfolios/enrollment-params`：後端由 operator 先部署帳戶（地址不變、owner 仍是使用者）。
 *    還沒部署好回 202（或回應標示未部署），重試同一個請求，直到帳戶已部署。
 * 2. 前端自己再確認鏈上已有帳戶程式碼，才由 owner 簽 sudo UserOp：`enroll(帳戶, 策略, 目前生效版本)`＋approve。
 *    UserOp 一律不帶 initCode／factory 資料（公開 chain 97 的 Kernel MetaFactory 沒有質押，bundler 會拒絕）。
 * 3. `POST /portfolios/enrollment-confirm`：後端讀鏈上 enrollments 確認後建立投組。
 *
 * 純邏輯＋可注入的等待：不碰 React。
 */
import type { Address, Hex } from 'viem';
import { FOLLOW_VERSIONS_TERMS_HASH } from './atp-contracts';

/** 後端準備好的加入參數（backend#126 `POST /portfolios/enrollment-params` 的 200）。 */
export type EnrollmentPreparation = {
  account: Address;
  /** 後端接受的版本（鏈上目前生效版，非零 uint16）。簽名前再和鏈上核對。 */
  expectedVersion: number;
  configHash: Hex;
  performanceFeeBps: number;
  /** ISO 時間：這一版生效的時間。 */
  activeAt: string;
};

/** 後端回應不完整或不合規：停下來，不簽、不送（審查 #95 第 5 項）。 */
export class EnrollmentPreparationError extends Error {
  constructor(public readonly field: string) {
    super(`The fund account came back incomplete (${field}), so nothing was signed or sent. Please try again later.`);
    this.name = 'EnrollmentPreparationError';
  }
}

/** 帳戶還沒部署好（等太久）：不簽、不送。 */
export class AccountNotReadyError extends Error {
  constructor() {
    super('Your fund account is still being set up, so nothing was sent. Please try again in a minute.');
    this.name = 'AccountNotReadyError';
  }
}

const isUint = (value: unknown, max: number, min = 0): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * 準備好了沒（backend#126）：202 是還沒部署好（重試同一個請求，回 null）。200 要每一項都對才算好，
 * 少一項或不對就丟 `EnrollmentPreparationError`（停下來，不重試、不簽）：
 * `accountDeployed === true`、帳戶地址、`expectedVersion` 是非零 uint16、`configHash` 是 bytes32、
 * `termsHash` 等於合約的 `FOLLOW_VERSIONS_TERMS`、`performanceFeeBps` 是 0–10000 的整數、`activeAt` 是有效時間。
 */
export function preparationReady(status: number, body: unknown): EnrollmentPreparation | null {
  if (status === 202) return null;
  if (status !== 200) throw new EnrollmentPreparationError(`status ${status}`);
  if (typeof body !== 'object' || body === null) throw new EnrollmentPreparationError('body');
  const record = body as Record<string, unknown>;
  if (record.accountDeployed !== true) throw new EnrollmentPreparationError('accountDeployed');
  if (typeof record.account !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(record.account)) throw new EnrollmentPreparationError('account');
  if (!isUint(record.expectedVersion, 65_535, 1)) throw new EnrollmentPreparationError('expectedVersion');
  if (typeof record.configHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(record.configHash)) throw new EnrollmentPreparationError('configHash');
  if (typeof record.termsHash !== 'string' || record.termsHash.toLowerCase() !== FOLLOW_VERSIONS_TERMS_HASH) throw new EnrollmentPreparationError('termsHash');
  if (!isUint(record.performanceFeeBps, 10_000)) throw new EnrollmentPreparationError('performanceFeeBps');
  if (typeof record.activeAt !== 'string' || !Number.isFinite(Date.parse(record.activeAt))) throw new EnrollmentPreparationError('activeAt');
  return {
    account: record.account as Address,
    expectedVersion: record.expectedVersion,
    configHash: record.configHash as Hex,
    performanceFeeBps: record.performanceFeeBps,
    activeAt: record.activeAt,
  };
}

/** 畫面上買家確認的版本（版本號＋configHash），和後端這次要簽的不同：不簽，請買家看過新內容再買一次。 */
export class ShownVersionChangedError extends Error {
  constructor(public readonly version: number) {
    super(`This fund's settings just changed to version ${version}. Review the updated settings and buy again. Nothing was signed or sent.`);
    this.name = 'ShownVersionChangedError';
  }
}

/**
 * 簽名前核對（審查 #95 第二輪 #4）：買家在畫面上看到並按下買入的，必須就是後端這次接受、要簽的那一版——
 * 版本號與 configHash 都相同。畫面還沒讀到版本（`shown` 是 null）也不簽。跨過生效時間時，畫面可能還是舊版、
 * 後端與鏈上已是新版：這時丟 `ShownVersionChangedError`，呼叫端刷新內容、中止這一次。
 */
export function assertShownVersion(shown: { version: number; configHash?: string } | null, prepared: Pick<EnrollmentPreparation, 'expectedVersion' | 'configHash'>): void {
  if (shown === null || shown.version !== prepared.expectedVersion || typeof shown.configHash !== 'string'
    || shown.configHash.toLowerCase() !== prepared.configHash.toLowerCase()) {
    throw new ShownVersionChangedError(prepared.expectedVersion);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 重試準備請求直到帳戶已部署；超過次數丟 `AccountNotReadyError`。 */
export async function waitForPreparation(
  fetchPreparation: () => Promise<{ status: number; body: unknown }>,
  options: { attempts?: number; delayMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<EnrollmentPreparation> {
  const { attempts = 20, delayMs = 3_000, wait = sleep } = options;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { status, body } = await fetchPreparation();
    const ready = preparationReady(status, body);
    if (ready !== null) return ready;
    if (attempt < attempts - 1) await wait(delayMs);
  }
  throw new AccountNotReadyError();
}

/** 等鏈上看得到帳戶程式碼（後端說好了，但這個 RPC 可能慢一點）。 */
export async function waitForAccountCode(
  getCode: (account: Address) => Promise<string | undefined>,
  account: Address,
  options: { attempts?: number; delayMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const { attempts = 10, delayMs = 2_000, wait = sleep } = options;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const code = await getCode(account).catch(() => undefined);
    if (code !== undefined && code !== '0x') return;
    if (attempt < attempts - 1) await wait(delayMs);
  }
  throw new AccountNotReadyError();
}
