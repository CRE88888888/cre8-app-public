/**
 * P11 版本通知期（cre8-contracts#54）在畫面上要用的純邏輯：待生效版本的變更摘要、只能賣的資產、
 * 建立者下次能發版的時間。鏈上讀取在 `lib/atp-contracts.ts` 的 `readVersionSchedule`。
 *
 * 規則（合約 `docs/versioning-p11.zh-TW.md`）：
 * - 新版本至少 24 小時後生效；只調低績效費（其他設定完全相同）可立即生效。
 * - 同時只有一個待生效版本；建立者可在生效前取消；兩次發版至少隔 7 天（取消的也算）。
 * - 帳戶自動跟隨最新已生效版本。曾經生效過、新版本拿掉的資產：可賣回 USDT，不能再買。
 * 純邏輯：不碰 React、不碰 fetch。
 */
import { PUBLICATION_INTERVAL_SECONDS } from './atp-contracts';

/** 鏈上一個版本（只列畫面用得到的）。 */
export type OnchainVersion = {
  version: number;
  assets: { asset: string; weightBps: number }[];
  /** unix 秒。 */
  activeAt: number;
  settingsHash: string;
  performanceFeeBps: number;
  /** 這一版的 configHash（P11 Version 第七欄）；簽名前和畫面上確認的版本比對用。 */
  configHash?: string;
};

/** 每個資產怎麼買（後端版本的 `execution`，per_asset）：給變更摘要比對策略用。 */
export type AssetPlay = Record<string, string>;

export type VersionChange =
  | { kind: 'added'; asset: string; weightBps: number }
  | { kind: 'removed'; asset: string; weightBps: number }
  | { kind: 'weight'; asset: string; from: number; to: number }
  | { kind: 'play'; asset: string; from: string; to: string }
  | { kind: 'fee'; from: number; to: number }
  /** settingsHash 變了，但拿不到兩版的逐資產設定時，只說「買法有變」。 */
  | { kind: 'settings' };

/** 只調低績效費（其他設定完全相同）：合約允許立即生效。 */
export function feeOnlyDecrease(active: OnchainVersion, next: OnchainVersion): boolean {
  if (next.performanceFeeBps >= active.performanceFeeBps || next.settingsHash.toLowerCase() !== active.settingsHash.toLowerCase()) return false;
  if (next.assets.length !== active.assets.length) return false;
  // 合約比的是資產順序也相同。
  return next.assets.every((row, index) => row.asset.toLowerCase() === active.assets[index]?.asset.toLowerCase() && row.weightBps === active.assets[index]?.weightBps);
}

/**
 * 待生效版本相對目前版本改了什麼：資產（新增／移除）、權重、每個資產的策略、績效費。
 * `plays` 是兩版的逐資產買法（地址小寫 → 'hold'／'stack · weekly 12' 之類的說明）；沒有就只看 settingsHash。
 */
export function versionChanges(active: OnchainVersion, next: OnchainVersion, plays?: { active: AssetPlay; next: AssetPlay } | null): VersionChange[] {
  const changes: VersionChange[] = [];
  const before = new Map(active.assets.map((row) => [row.asset.toLowerCase(), row.weightBps]));
  const after = new Map(next.assets.map((row) => [row.asset.toLowerCase(), row.weightBps]));
  for (const row of next.assets) {
    const key = row.asset.toLowerCase();
    const was = before.get(key);
    if (was === undefined) changes.push({ kind: 'added', asset: row.asset, weightBps: row.weightBps });
    else if (was !== row.weightBps) changes.push({ kind: 'weight', asset: row.asset, from: was, to: row.weightBps });
  }
  for (const row of active.assets) {
    if (!after.has(row.asset.toLowerCase())) changes.push({ kind: 'removed', asset: row.asset, weightBps: row.weightBps });
  }
  if (active.settingsHash.toLowerCase() !== next.settingsHash.toLowerCase()) {
    const playChanges: VersionChange[] = [];
    if (plays) {
      for (const row of next.assets) {
        const key = row.asset.toLowerCase();
        const from = plays.active[key];
        const to = plays.next[key];
        if (from !== undefined && to !== undefined && from !== to) playChanges.push({ kind: 'play', asset: row.asset, from, to });
      }
    }
    changes.push(...(playChanges.length > 0 ? playChanges : [{ kind: 'settings' } as const]));
  }
  if (active.performanceFeeBps !== next.performanceFeeBps) changes.push({ kind: 'fee', from: active.performanceFeeBps, to: next.performanceFeeBps });
  return changes;
}

const pct = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/** 一行變更說明（畫面列表用）。 */
export function changeLine(change: VersionChange, symbolOf: (asset: string) => string): string {
  switch (change.kind) {
    case 'added': return `Adds ${symbolOf(change.asset)} at ${pct(change.weightBps)}`;
    case 'removed': return `Removes ${symbolOf(change.asset)} (was ${pct(change.weightBps)}). You can still sell what you hold; it is no longer bought.`;
    case 'weight': return `${symbolOf(change.asset)}: ${pct(change.from)} → ${pct(change.to)}`;
    case 'play': return `${symbolOf(change.asset)}: ${change.from} → ${change.to}`;
    case 'fee': return `Performance fee: ${pct(change.from)} → ${pct(change.to)}`;
    case 'settings': return 'How assets are bought changes (strategy settings).';
  }
}

/** 後端版本 `execution`（per_asset）裡每個資產的買法說明；形狀不對回 null。 */
export function assetPlays(execution: unknown): AssetPlay | null {
  const assets = (execution as { kind?: unknown; assets?: unknown } | null)?.kind === 'per_asset' ? (execution as { assets?: unknown }).assets : null;
  if (!Array.isArray(assets)) return null;
  const plays: AssetPlay = {};
  for (const entry of assets) {
    const item = entry as { asset?: unknown; execution?: { kind?: unknown; every?: unknown; slices?: unknown } } | null;
    if (typeof item?.asset !== 'string' || item.execution === undefined) continue;
    const mode = item.execution;
    plays[item.asset.toLowerCase()] = mode?.kind === 'stack' ? `Stack, ${String(mode.every)} over ${String(mode.slices)} buys` : 'Buy & hold';
  }
  return plays;
}

/** 曾經生效、目前版本沒有的資產：可賣回 USDT，不能再買（地址小寫）。 */
export function sellOnlyAssets(historical: readonly string[], active: readonly { asset: string }[]): string[] {
  const now = new Set(active.map((row) => row.asset.toLowerCase()));
  return [...new Set(historical.map((asset) => asset.toLowerCase()))].filter((asset) => !now.has(asset));
}

/**
 * 這檔策略現在**生效**的那一版（審查 #95 第 4 項）：預覽、配置、簽名都用它，不用 `versions[0]`（後端倒序回傳，
 * 第一個可能是還沒生效的新版）。
 * - `onchainActive` 是數字：鏈上 `activeVersion`（chain 97 讀得到時以它為準），找同號的那一版；找不到回 undefined。
 * - `onchainActive` 是 null：鏈上說還沒有生效版本，回 undefined。
 * - 沒給（chain 56、或鏈上讀不到）：取 `activeAt` 已到（或沒有 activeAt 的舊版本）、不是 pending 的最大版本號。
 */
export function effectiveVersion<T extends { version: number; activeAt: string | null }>(
  versions: readonly T[] | undefined,
  onchainActive?: number | null,
  now: number = Date.now(),
): T | undefined {
  if (versions === undefined || versions.length === 0) return undefined;
  if (onchainActive !== undefined) return onchainActive === null ? undefined : versions.find((item) => item.version === onchainActive);
  let best: T | undefined;
  for (const item of versions) {
    if ((item as { pending?: boolean }).pending === true) continue;
    if (item.activeAt !== null && !(Date.parse(item.activeAt) <= now)) continue;
    if (best === undefined || item.version > best.version) best = item;
  }
  return best;
}

/**
 * 發版回應的 `activeAt`（ISO）換成 unix 秒，給「何時開放買入」用（審查 #95 第 12 項）：不要自己用本機時間＋24h 算，
 * 後端是＋24h＋60 秒、重試還會沿用原值。格式不對或沒給回 undefined（畫面就不寫時間）。
 */
export function opensAtFrom(activeAt: unknown): number | undefined {
  if (typeof activeAt !== 'string') return undefined;
  const ms = Date.parse(activeAt);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;
}

/** 投組暫停買入的原因（backend#126 `GET /portfolios/:id/status` 的 `buyingPaused`）。 */
export type BuyingPaused = { reason: 'NEW_VERSION_ACTIVE'; joinedVersion: number; activeVersion: number };

const isVersionNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;

/**
 * 嚴格讀 `buyingPaused`：只有 reason 是 NEW_VERSION_ACTIVE、兩個版本都是非零 uint16 而且不同，才算暫停；
 * null、沒有這個欄位或形狀不對都回 null（不顯示，也不擋；後端在送單前另有自己的版本檢查）。
 */
export function parseBuyingPaused(value: unknown): BuyingPaused | null {
  if (typeof value !== 'object' || value === null) return null;
  const { reason, joinedVersion, activeVersion } = value as Record<string, unknown>;
  if (reason !== 'NEW_VERSION_ACTIVE' || !isVersionNumber(joinedVersion) || !isVersionNumber(activeVersion) || joinedVersion === activeVersion) return null;
  return { reason, joinedVersion, activeVersion };
}

/** 基金頁的停買說明：新版已生效、這個投組暫停買入、隨時可賣出或原樣轉出（與帳戶區的 P11 說明同一句話）。 */
export function buyingPausedText(paused: BuyingPaused): string {
  return `Version ${paused.activeVersion} is now in effect. This portfolio was set up on version ${paused.joinedVersion}, so new buys into it are paused until portfolios can move to the new version (opening within a week). You can still sell, or take your assets out as they are, at any time.`;
}

/** 建立者下次最早能發新版的時間（unix 秒）；從來沒發過回 0。 */
export function nextPublishAt(lastPublishedAt: number): number {
  return lastPublishedAt === 0 ? 0 : lastPublishedAt + PUBLICATION_INTERVAL_SECONDS;
}

/** 生效時間給人看（使用者這台裝置的當地時間）。 */
export function whenText(unixSeconds: number, locale = 'en-US', timeZone?: string): string {
  return new Date(unixSeconds * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone === undefined ? {} : { timeZone }) });
}

/** 發版說明（建立者）：一般變更 24 小時後生效；只調低績效費立即生效；7 天內不能再發；生效前可取消。 */
export const PUBLISH_RULES = {
  delay: 'New settings take effect 24 hours after you publish, so holders have time to exit if they disagree.',
  feeCut: 'Lowering only the performance fee takes effect right away.',
  interval: 'After publishing, you can’t publish again for 7 days (a cancelled version counts too).',
  cancel: 'You can cancel the new settings any time before they take effect.',
} as const;
