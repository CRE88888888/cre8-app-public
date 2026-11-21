/**
 * My mix 的純計算（cre8-app#132）：比例、金額、名稱、報酬。不 import React，方便測試。
 *
 * 比例一律用萬分比整數（後端 weightBps，合計 10000）。用戶看不到「比例加總不對」：
 * 加減一個成分時，其他成分照原本的相對大小自動補回，總和永遠是 10000。
 */
import { mixAsset } from './mix-catalog';
import type { MixAsset } from './mix-types';

export const MAX_ASSETS = 10;
/** 每按一下 +／− 改 5%。 */
export const STEP_BPS = 500;
/** 每個成分至少 5%（要拿掉就取消選取，不是把比例調到 0）。 */
export const MIN_WEIGHT_BPS = 500;
export const TOTAL_BPS = 10_000;
export const USDT_DECIMALS = 18;

/** 平均分配；除不盡的零頭給排在前面的。 */
export function equalWeights(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(TOTAL_BPS / count);
  const extra = TOTAL_BPS - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
}

/** 這個成分最多能到多少（其他每個都留最低 5%）。 */
export function maxWeight(count: number): number {
  return TOTAL_BPS - MIN_WEIGHT_BPS * (count - 1);
}

/**
 * 把第 `index` 個成分設成 `target`，其他照原本的相對大小分掉剩下的，總和維持 10000，
 * 每個都至少 5%。只有一個成分時固定 100%。
 */
export function setWeight(weights: readonly number[], index: number, target: number): number[] {
  const count = weights.length;
  if (count <= 1) return count === 1 ? [TOTAL_BPS] : [];
  const value = Math.min(maxWeight(count), Math.max(MIN_WEIGHT_BPS, Math.round(target)));
  const others = weights.map((weight, i) => ({ i, weight })).filter(({ i }) => i !== index);
  const remaining = TOTAL_BPS - value;
  // 先給每個最低值，多出來的照原比例分（原比例全為 0 時平均分）。
  const spare = remaining - MIN_WEIGHT_BPS * others.length;
  const basis = others.map(({ weight }) => Math.max(0, weight - MIN_WEIGHT_BPS));
  const basisTotal = basis.reduce((sum, b) => sum + b, 0);
  const shares = others.map((_, k) => (basisTotal === 0 ? spare / others.length : (spare * basis[k]!) / basisTotal));
  const floored = shares.map(Math.floor);
  let left = spare - floored.reduce((sum, s) => sum + s, 0);
  // 最大餘數法補零頭，同餘數時排前面的先拿。
  const order = shares.map((share, k) => ({ k, rest: share - floored[k]! })).sort((a, b) => b.rest - a.rest || a.k - b.k);
  for (const { k } of order) {
    if (left <= 0) break;
    floored[k]! += 1;
    left -= 1;
  }
  const next = [...weights];
  next[index] = value;
  others.forEach(({ i }, k) => {
    next[i] = MIN_WEIGHT_BPS + floored[k]!;
  });
  return next;
}

/** +／− 一格（5%）。到頂或到底時不變。 */
export function stepWeight(weights: readonly number[], index: number, direction: 1 | -1): number[] {
  const current = weights[index] ?? 0;
  return setWeight(weights, index, current + direction * STEP_BPS);
}

/** 萬分比 → 畫面上的百分比：整數就不帶小數（25%），否則一位（33.3%）。 */
export function weightLabel(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? `${pct}%` : `${(Math.round(pct * 10) / 10).toFixed(1)}%`;
}

/** 名稱自動產生：「NVDA + TSLA + 2 more」（與後端預設同一種寫法，但用畫面代號）。 */
export function defaultMixName(symbols: readonly string[]): string {
  const tickers = symbols.map((symbol) => mixAsset(symbol)?.ticker ?? symbol);
  if (tickers.length === 0) return 'My mix';
  if (tickers.length <= 2) return tickers.join(' + ');
  return `${tickers[0]} + ${tickers[1]} + ${tickers.length - 2} more`;
}

/**
 * 登入後有 X handle 時的預設名稱：「cre8admin 3」。
 * 序號 = 已有的組合數（`GET /me/mixes`，含已出場）+ 1；跟現有名稱撞了就往上加到不撞（不分大小寫）。
 */
export function handleMixName(handle: string, existingNames: readonly string[]): string {
  const base = handle.trim().replace(/^@/, '');
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  let n = existingNames.length + 1;
  while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

/** 用戶輸入的金額（「1,000.5」）→ 18 位小數的 raw。不合法回 null。 */
export function parseUsdtInput(text: string): bigint | null {
  const clean = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  const digits = fraction.slice(0, USDT_DECIMALS).padEnd(USDT_DECIMALS, '0');
  return BigInt(whole!) * 10n ** BigInt(USDT_DECIMALS) + BigInt(digits);
}

/** raw → 「1,234.56」（最多兩位小數，無條件捨去）。 */
export function formatUsdt(raw: string | bigint, maxFraction = 2): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(USDT_DECIMALS);
  const whole = abs / unit;
  const scale = 10n ** BigInt(USDT_DECIMALS - maxFraction);
  // 有小數就固定兩位（1,184.20），整數不帶小數（1,300）。
  const digits = ((abs % unit) / scale).toString().padStart(maxFraction, '0');
  const fraction = /^0+$/.test(digits) ? '' : digits;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction === '' ? '' : `.${fraction}`}`;
}

/** 報酬萬分比字串 → 「+12.3%」／「−4.5%」；null 回 null。 */
export function formatReturnBps(bps: string | number | null): string | null {
  if (bps === null) return null;
  const value = Number(bps) / 100;
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return '0%';
  const abs = Math.abs(rounded);
  return `${rounded > 0 ? '+' : '−'}${Number.isInteger(abs) || abs >= 100 ? Math.round(abs) : abs.toFixed(1)}%`;
}

/** 後端的百分比字串（"23.41000000"）→ 「+23%」。 */
export function formatPctString(value: string | null): string | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded === 0) return '0%';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`;
}

/** 距離下次開盤多久：「5h」「40m」「2d」。 */
export function untilLabel(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 'a moment';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** 「Nov 21」或跨年時「Nov 21, 2027」。 */
export function shortDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 成分與比例一樣（不管順序）：Change mix 只改名稱或選項時不用簽。 */
export function sameAssets(a: readonly MixAsset[], b: readonly MixAsset[]): boolean {
  if (a.length !== b.length) return false;
  const weights = new Map(a.map((asset) => [asset.assetId.toLowerCase(), asset.weightBps]));
  return b.every((asset) => weights.get(asset.assetId.toLowerCase()) === asset.weightBps);
}

/** 測試網一次領的測試 USDT（18 位小數）。 */
export const TEST_USDT_RAW = 1000n * 10n ** 18n;
/** 預覽還沒回來時的最低入金（後端既有規則 50 USDT）。 */
export const FALLBACK_MINIMUM_RAW = 50n * 10n ** 18n;

/**
 * Add money 這筆能不能轉（C3 複查 #133 第 2 點）：低於最低入金就先擋，不轉。
 * 轉了也記不成投入（funding-lots 回 BELOW_MINIMUM_ALLOCATION），帳上現金對不起來，組合會一直不買。
 */
export function addMoneyCheck(value: bigint | null, minimum: bigint): 'empty' | 'below-minimum' | 'ok' {
  if (value === null || value <= 0n) return 'empty';
  return value < minimum ? 'below-minimum' : 'ok';
}
