/**
 * 生息簽名的流程（cre8-app#95 複審 F2–F5），不碰 React，簽名、通知、重讀都由呼叫端注入。
 *
 * - 同意：每批最多 16 個市場；**每一批**簽名前重讀狀態、重新驗證那一批與地址簿（F4）。
 * - 全部領回：所有 `requestExit` 放進同一個 UserOp 一次送（最多 30 個市場、30 筆 call，在 32 內），與後端全帳戶退出意圖一致（F2）。
 * - UserOp 一送出就記 `submitted`（userOpHash）；上鏈成功改 `confirmed`（txHash），**在第一次通知之前**；通知成功才刪（F3／F5）。
 * - 中途停下：回報已完成、已送出待確認、還沒送三種（`YieldFlowStopped`），原錯誤放在 `cause`。
 * - 每次真正送簽前重讀這個帳戶的待辦（含其他分頁寫的）；有 submitted 就停（第三輪複審 R2）。
 * - hash 在廣播前就存（R1）：bundler 明確拒絕（`BundlerRejected`）才刪記錄、算沒送；其他送出失敗都留著待對帳。
 */
import {
  YieldStateChanged,
  checkYieldSigning,
  consentCalls,
  exitCalls,
  recheckBeforeSigning,
  revokeCalls,
  yieldBatches,
} from './yield';
import type { AssetYield, PortfolioYield, YieldBook, YieldCall, YieldMarket, YieldMarketList } from './yield';
import type { PendingKind, PendingRecord } from './yield-pending';
import { BundlerRejected } from './userop-send';

/** paymaster 一個 UserOp 最多幾筆 call（後端 PAYMASTER_CALL_FORBIDDEN 的上限）。 */
export const MAX_CALLS_PER_USEROP = 32;

export type FlowDeps = {
  kind: PendingKind;
  /** consent／revoke：畫面上選的市場；exit 不用（用最新的可停止清單）。 */
  wanted: readonly string[];
  chainId: number;
  executor: string;
  book: YieldBook | null;
  reload: () => Promise<{ data: PortfolioYield | null; markets: YieldMarketList | null }>;
  /** 送一個 UserOp；送進 bundler 後馬上呼叫 `onSubmitted`，再等 receipt。 */
  sign: (calls: readonly YieldCall[], onSubmitted: (userOpHash: string) => void) => Promise<{ userOpHash: string; txHash: string; success: boolean }>;
  /** 通知後端（失敗丟原錯誤）。 */
  notify: (body: { markets: string[]; txHash: string }) => Promise<void>;
  store: { save: (record: PendingRecord) => void; remove: (userOpHash: string) => void };
  /** 這個帳戶現在有沒有「已送出、結果不明」的簽名（每次送簽前重讀，含其他分頁）。 */
  hasUnresolved: () => boolean;
  retryDelayMs?: number;
  onBatch?: (index: number, total: number) => void;
};

/** 有已送出、還沒對完帳的簽名（可能是另一個分頁送的）：先對帳，不簽新的。 */
export class YieldSigningPaused extends Error {
  constructor() {
    super('A lending signature sent earlier is not confirmed yet. Check its status first, then try again.');
    this.name = 'YieldSigningPaused';
  }
}

export class YieldFlowStopped extends Error {
  readonly cause: unknown;
  /** 已上鏈成功的。 */
  readonly done: AssetYield[];
  /** 已送出、還不知道結果的（不能當成沒送）。 */
  readonly submitted: AssetYield[];
  /** 還沒送的。 */
  readonly notSent: AssetYield[];
  constructor(cause: unknown, done: AssetYield[], submitted: AssetYield[], notSent: AssetYield[]) {
    super((cause as Error)?.message ?? String(cause));
    this.name = 'YieldFlowStopped';
    this.cause = cause;
    this.done = done;
    this.submitted = submitted;
    this.notSent = notSent;
  }
}

function callsFor(kind: PendingKind, registry: string, executor: string, markets: readonly YieldMarket[]): YieldCall[] {
  if (kind === 'consent') return consentCalls({ registry, executor, markets });
  if (kind === 'revoke') return revokeCalls({ registry, markets });
  return exitCalls({ registry, markets });
}

/** 通知後端，失敗多試兩次；再不行丟最後一個原錯誤（code／status 不變）。 */
export async function notifyWithRetry(notify: FlowDeps['notify'], body: { markets: string[]; txHash: string }, delayMs = 1_000): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await notify(body);
      return;
    } catch (cause) {
      lastError = cause;
      if (attempt < 3 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function runYieldFlow(deps: FlowDeps): Promise<AssetYield[]> {
  const done: AssetYield[] = [];
  let submitted: AssetYield[] = [];
  let notSent: AssetYield[] = [];
  try {
    let fresh = await deps.reload();
    if (fresh.markets === null) throw new YieldStateChanged();
    const first = recheckBeforeSigning(deps.kind, deps.wanted, fresh.data, fresh.markets.markets);
    const batches = deps.kind === 'exit' ? [first] : yieldBatches(first);
    notSent = [...first];
    for (const [index, batch] of batches.entries()) {
      if (index > 0) fresh = await deps.reload();
      const list = fresh.markets;
      if (list === null) throw new YieldStateChanged();
      // 這一批用剛讀到的狀態重新驗證（exit 用最新的全部可停止市場）。
      const rows = recheckBeforeSigning(deps.kind, deps.kind === 'exit' ? [] : batch.map((row) => row.market), fresh.data, list.markets);
      const markets = rows.map((row) => list.markets.find((market) => market.id === row.market));
      if (markets.some((market) => market === undefined)) throw new YieldStateChanged();
      const ready = markets as YieldMarket[];
      checkYieldSigning({ chainId: deps.chainId, executor: deps.executor, registry: list.registry, markets: ready, rows }, deps.book);
      const calls = callsFor(deps.kind, list.registry, deps.executor, ready);
      if (calls.length > MAX_CALLS_PER_USEROP) throw new Error(`Too many markets for one signature (${calls.length} calls).`);
      if (deps.hasUnresolved()) throw new YieldSigningPaused();
      deps.onBatch?.(index, batches.length);
      const ids = ready.map((market) => market.id);
      let saved: string | null = null;
      let receipt: Awaited<ReturnType<FlowDeps['sign']>>;
      try {
        receipt = await deps.sign(calls, (userOpHash) => {
          // bundler 回的 hash 跟事先算的不同時，換掉舊的那筆。
          if (saved !== null && saved !== userOpHash) deps.store.remove(saved);
          saved = userOpHash;
          deps.store.save({ kind: deps.kind, markets: ids, userOpHash, txHash: null, state: 'submitted' });
          submitted = rows;
          notSent = notSent.filter((row) => !rows.some((item) => item.market === row.market));
        });
      } catch (cause) {
        if (cause instanceof BundlerRejected) {
          // bundler 明確沒收：刪掉記錄，這一批算沒送。
          deps.store.remove(cause.userOpHash);
          if (saved !== null) deps.store.remove(saved);
          submitted = [];
          notSent = [...rows, ...notSent.filter((row) => !rows.some((item) => item.market === row.market))];
        }
        throw cause;
      }
      submitted = [];
      notSent = notSent.filter((row) => !rows.some((item) => item.market === row.market));
      if (!receipt.success) {
        deps.store.remove(receipt.userOpHash);
        throw new Error(`The transaction landed on-chain but reverted: ${receipt.txHash}`);
      }
      // 先存證據、再通知；通知成功才刪。
      deps.store.save({ kind: deps.kind, markets: ids, userOpHash: receipt.userOpHash, txHash: receipt.txHash, state: 'confirmed' });
      done.push(...rows);
      await notifyWithRetry(deps.notify, { markets: ids, txHash: receipt.txHash }, deps.retryDelayMs);
      deps.store.remove(receipt.userOpHash);
    }
    return done;
  } catch (cause) {
    throw new YieldFlowStopped(cause, done, submitted, notSent);
  }
}

/** 用原 userOpHash 對帳的結果：還沒有 receipt 就等；成功改成已確認去通知；revert 就丟掉（沒有生效）。 */
export function resolveSubmitted(
  record: PendingRecord,
  receipt: { txHash: string; success: boolean } | null,
): { action: 'wait' } | { action: 'notify'; record: PendingRecord } | { action: 'drop' } {
  if (receipt === null) return { action: 'wait' };
  if (!receipt.success) return { action: 'drop' };
  return { action: 'notify', record: { ...record, txHash: receipt.txHash, state: 'confirmed' } };
}
