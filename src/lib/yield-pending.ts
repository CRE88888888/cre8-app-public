/**
 * 已送出、還沒對完帳的生息簽名（cre8-app#95 審查第 5 項、複審 F3／F5）。
 *
 * 同意／取消／全部領回都是「先簽鏈上、再通知後端」。一筆簽名有兩個階段要記：
 *   - `submitted`：UserOp 已送進 bundler（有 userOpHash），還不知道有沒有上鏈。用原 hash 對帳，釐清前不能重簽。
 *   - `confirmed`：已上鏈成功（有 txHash），還沒通知到後端。通知成功才刪，可以只重送原 txHash。
 * 存在這個瀏覽器，綁定鏈、帳戶與投組；只存公開的 hash 與市場 id。
 * storage 是唯一來源；記憶體只放「沒寫進 storage」的變更（storage 不能用或寫入失敗），寫入成功就清掉，
 * 不會用舊副本蓋掉其他分頁更新或刪掉的狀態（第三輪複審 R3）。舊版 `v1` 的已上鏈待通知紀錄讀到就搬到 v2（R4）。
 */

export type PendingKind = 'consent' | 'revoke' | 'exit';
export type PendingRecord = {
  kind: PendingKind;
  markets: string[];
  userOpHash: string;
  txHash: string | null;
  state: 'submitted' | 'confirmed';
};
export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KINDS: readonly PendingKind[] = ['consent', 'revoke', 'exit'];
const HASH = /^0x[0-9a-fA-F]{64}$/;
/** 沒寫進 storage 的變更（storage 不能用或寫入失敗）：同一頁還看得到、還能重送。寫入成功就清掉。 */
const unsaved = new Map<string, PendingRecord[]>();

export function pendingKey(chainId: number, account: string, portfolioId: number): string {
  return `cre8.yield.unrecorded.v2.${chainId}.${account.toLowerCase()}.${portfolioId}`;
}

function valid(item: unknown): item is PendingRecord {
  if (typeof item !== 'object' || item === null) return false;
  const record = item as PendingRecord;
  return (
    KINDS.includes(record.kind) &&
    typeof record.userOpHash === 'string' && HASH.test(record.userOpHash) &&
    (record.txHash === null || (typeof record.txHash === 'string' && HASH.test(record.txHash))) &&
    (record.state === 'submitted' || (record.state === 'confirmed' && record.txHash !== null)) &&
    Array.isArray(record.markets) && record.markets.every((market) => typeof market === 'string')
  );
}

function parseList(raw: string | null): unknown[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** 讀 storage；讀不到回 null（跟「沒有紀錄」分開）。 */
function fromStorage(storage: PendingStorage | null, key: string): PendingRecord[] | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(key);
    return parseList(raw).filter(valid).map((item) => ({ ...item, markets: [...item.markets] }));
  } catch {
    return null;
  }
}

/** 舊版（99834fc 前）`v1` 紀錄：`{kind, markets, txHash}`，都是已上鏈、待通知。沒有 userOpHash，用 txHash 當識別。 */
function legacyRecords(storage: PendingStorage | null, key: string): { legacyKey: string; records: PendingRecord[] } | null {
  if (storage === null || !key.includes('.v2.')) return null;
  const legacyKey = key.replace('.v2.', '.v1.');
  try {
    const raw = storage.getItem(legacyKey);
    if (raw === null) return null;
    const records = parseList(raw)
      .filter((item): item is { kind: PendingKind; markets: string[]; txHash: string } => {
        const value = item as { kind?: unknown; markets?: unknown; txHash?: unknown } | null;
        return (
          typeof value === 'object' && value !== null && KINDS.includes(value.kind as PendingKind) &&
          typeof value.txHash === 'string' && HASH.test(value.txHash) &&
          Array.isArray(value.markets) && value.markets.every((market) => typeof market === 'string')
        );
      })
      .map((item): PendingRecord => ({ kind: item.kind, markets: [...item.markets], userOpHash: item.txHash, txHash: item.txHash, state: 'confirmed' }));
    return { legacyKey, records };
  } catch {
    return null;
  }
}

function write(storage: PendingStorage | null, key: string, records: PendingRecord[]): void {
  if (storage !== null) {
    try {
      if (records.length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(records));
      unsaved.delete(key);
      return;
    } catch {
      /* 留在記憶體 */
    }
  }
  if (records.length === 0) unsaved.delete(key);
  else unsaved.set(key, records);
}

export function readPendingRecords(storage: PendingStorage | null, key: string): PendingRecord[] {
  // 有沒寫進去的本地變更：以它為準（storage 這時多半也不能用）。
  const local = unsaved.get(key);
  if (local !== undefined) return local.map((item) => ({ ...item, markets: [...item.markets] }));
  const stored = fromStorage(storage, key) ?? [];
  const legacy = legacyRecords(storage, key);
  if (legacy === null) return stored;
  const merged = [...stored, ...legacy.records.filter((item) => !stored.some((other) => other.userOpHash === item.userOpHash))];
  write(storage, key, merged);
  try {
    storage?.removeItem(legacy.legacyKey);
  } catch {
    /* ignore */
  }
  return merged;
}

/** 新增或更新（同一個 userOpHash 取代舊的）。 */
export function savePendingRecord(storage: PendingStorage | null, key: string, record: PendingRecord): void {
  write(storage, key, [...readPendingRecords(storage, key).filter((item) => item.userOpHash !== record.userOpHash), record]);
}

export function removePendingRecord(storage: PendingStorage | null, key: string, userOpHash: string): void {
  write(storage, key, readPendingRecords(storage, key).filter((item) => item.userOpHash !== userOpHash));
}

/** `eth_getUserOperationReceipt` 的回應：null = bundler 還沒有 receipt；有 = 上鏈結果。 */
export function userOpReceiptFrom(body: unknown): { txHash: string; success: boolean } | null {
  const value = body as { result?: unknown; error?: { message?: unknown } } | null;
  if (value !== null && typeof value === 'object' && value.error !== undefined) {
    throw new Error(`Could not check the transaction: ${String(value.error?.message ?? 'bundler error')}`);
  }
  const result = value?.result as { success?: unknown; receipt?: { transactionHash?: unknown } } | null | undefined;
  if (result === null || result === undefined) return null;
  const txHash = result.receipt?.transactionHash;
  if (typeof txHash !== 'string' || !HASH.test(txHash) || typeof result.success !== 'boolean') {
    throw new Error('Could not check the transaction: the receipt is incomplete.');
  }
  return { txHash, success: result.success };
}

/** 瀏覽器的 localStorage；讀不到（隱私模式、SSR）回 null。 */
export function browserStorage(): PendingStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
