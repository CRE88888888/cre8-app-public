/**
 * 對 executor 的 approve 分批送（cre8-app#93）。
 *
 * 代付驗證一筆 UserOp 最多收 32 個 call：33 個以上未授權資產包成一筆，`/paymaster/sponsor` 直接回
 * `403 PAYMASTER_CALL_FORBIDDEN`（32／33／92 已實測）。所以每 32 個一批，一批確認了才送下一批。
 *
 * 進度存在鏈上：每一批上鏈後那些資產的 allowance 就是 max，下一次（重試、或 Allowance 卡片的補授權）
 * 先讀 allowance 濾掉已授權的，只送剩下的，不會從頭再來。中途失敗時丟 `ApprovalBatchError`，
 * 帶著已完成幾批，讓畫面講清楚「已授權 N 個，還差 M 個」。
 */
export const APPROVALS_PER_USEROP = 32;

export function approvalBatches<T>(items: readonly T[], size: number = APPROVALS_PER_USEROP): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('batch size must be a positive integer');
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size));
  return batches;
}

export class ApprovalBatchError extends Error {
  readonly approved: number;
  readonly remaining: number;
  readonly technical: string;
  constructor(approved: number, remaining: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
    super(
      approved === 0
        ? reason
        : `${approved} asset${approved === 1 ? ' is' : 's are'} approved; ${remaining} still need approval. Press the button again to finish. ${reason}`,
    );
    this.name = 'ApprovalBatchError';
    this.approved = approved;
    this.remaining = remaining;
    this.technical = cause instanceof Error ? cause.message : String(cause);
    this.cause = cause;
  }
}

/**
 * 依序送每一批：`send` 要等那一批上鏈才回來（`sendSudoCalls` 就是這樣）。回最後一批的結果。
 * `onBatch(index, total)` 在每一批送出前呼叫，給進度訊息用。
 */
export async function sendInBatches<T, R>(
  items: readonly T[],
  send: (batch: T[]) => Promise<R>,
  onBatch?: (index: number, total: number, batch: T[]) => void,
  size: number = APPROVALS_PER_USEROP,
): Promise<R[]> {
  const batches = approvalBatches(items, size);
  const results: R[] = [];
  let done = 0;
  for (const [index, batch] of batches.entries()) {
    onBatch?.(index, batches.length, batch);
    try {
      results.push(await send(batch));
    } catch (cause) {
      throw new ApprovalBatchError(done, items.length - done, cause);
    }
    done += batch.length;
  }
  return results;
}

/**
 * 帳戶升版的 calls（enroll＋新資產的 approve）分批：approve 在前、enroll 放最後一批的最後（cre8-app#93）。
 * 以前 enroll 與所有 approve 包成一筆，新資產超過 31 個就被代付拒絕。順序反過來排是為了：中途失敗時帳戶還在舊版本，
 * 不會出現「已經換到新版、新資產卻還沒授權」；已送出的 approve 是對 executor 的 max allowance，重送無害。
 */
export function upgradeBatches<T extends { to: string }>(calls: readonly T[], registry: string, size: number = APPROVALS_PER_USEROP): T[][] {
  const isEnroll = (call: T): boolean => call.to.toLowerCase() === registry.toLowerCase();
  return approvalBatches([...calls.filter((call) => !isEnroll(call)), ...calls.filter(isEnroll)], size);
}

/** 進度訊息：「One signature for 5 assets…」或「Signature 2 of 3 · 32 assets…」。 */
export function approvalProgress(index: number, total: number, count: number): string {
  const assets = `${count} asset${count === 1 ? '' : 's'}`;
  return total <= 1 ? `One signature for ${assets}…` : `Signature ${index + 1} of ${total} · ${assets}…`;
}
