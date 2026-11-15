/**
 * 基金版本的執行設定：每個資產各自純持有（hold）或定期定額（stack）。
 *
 * 規格：docs#57 G0-4（使用者 2026-11-15 決定）——每個資產各自選策略；stack 的頻率、星期、時刻、期數也逐資產，
 * 全部由創作者設定，買的人只決定投入金額。生息逐資產選市場（APP-3 之前一律關）。
 * 後端契約：backend `docs/strategy-api.zh-TW.md`（BE-2，schema 2 的 `execution.kind = "per_asset"`）。
 *
 * 設計器每一列是一個資產的一種 play（參考設計的資料結構，不能改）。這裡把每一列換成後端的逐資產設定，
 * 換不了就回傳要使用者先改什麼。草稿本身一個欄位都不刪（舊設定留著，之後開放時還在）。
 * 純邏輯：不碰 React、不碰 fetch。
 */
import type { FundRules, Row } from '../reference/lib/fund-builder';
import { playLock } from './feature-flags';

export type ExecutionKind = 'hold' | 'stack';

/** 一個資產的 stack 排程，照後端格式：時刻是 UTC，weekday 0 是星期日，每天買的話 weekday 是 null。 */
export type StackExecution = { kind: 'stack'; every: 'daily' | 'weekly'; weekday: number | null; timeUtc: string; slices: number };
export type AssetExecution = { kind: 'hold' } | StackExecution;

/**
 * 整檔再平衡（使用者決定，docs TESTNET_PARAMETERS；backend#93 的 `execution.rebalance`）：只在全部資產都是
 * Buy & hold 時可選。none＝不再平衡（預設）；monthly＝每個 UTC 月一次；drift＝任一資產偏離目標超過 5 個百分點。
 */
export type Rebalance = 'none' | 'monthly' | 'drift';
/** drift 的門檻：5 個百分點（後端 500 bps，固定）。 */
export const REBALANCE_DRIFT_POINTS = 5;

/** stack 可設的期數（後端 2–52）。 */
export const STACK_SLICES = { min: 2, max: 52 } as const;

/** 設計裡擋住啟用的原因。名稱都是給畫面列出來的（策略名、設定名、資產名）。 */
export type ExecutionProblem =
  /** 用了還沒開放的策略（custom、dips、range、trend、lp、carry）。 */
  | { kind: 'excluded'; plays: string[] }
  /** hold／stack 帶了還沒開放的附加設定（持有期間出借、停利停損、價格上限、整檔規則）。 */
  | { kind: 'extras'; settings: string[] }
  /** stack 的排程不是每天／每週、或期數不在 2–52（舊草稿可能是每月、或 1000 期）。 */
  | { kind: 'schedule'; assets: string[] }
  /** 同一個資產分成兩列、兩列設定不同：後端一個資產只有一種設定。 */
  | { kind: 'split'; assets: string[] }
  /** 再平衡開著，但有資產是 Stack（`stack`），或是舊草稿的設定不是每月／偏離 5 點／回到原比例（`options`）。 */
  | { kind: 'rebalance'; reason: 'stack' | 'options' };

/** `assets`：設計器資產 key → 這個資產的執行設定。 */
export type DesignExecution = { assets: Map<string, AssetExecution>; rebalance: Rebalance } | { problem: ExecutionProblem };

/** 設計器的再平衡規則（參考設計的欄位）。 */
export type RebalanceRule = { on: boolean; how?: string; drift?: number; every?: string; weight?: string };

/** 設計器的再平衡規則換成後端的選項；開著但不是三個選項之一（舊草稿）回傳 null。 */
export function rebalanceOf(rule: RebalanceRule | undefined): Rebalance | null {
  if (!rule?.on) return 'none';
  if ((rule.weight ?? 'custom') !== 'custom') return null;
  if (rule.how === 'schedule') return rule.every === 'monthly' ? 'monthly' : null;
  if (rule.how === 'drift') return rule.drift === REBALANCE_DRIFT_POINTS ? 'drift' : null;
  return null;
}

/** 這次可以啟用的模式：hold 一直開著；stack 跟功能開關 `strategyDca`。 */
export function openKinds(stackOpen: boolean = playLock('stack') === null): ExecutionKind[] {
  return stackOpen ? ['hold', 'stack'] : ['hold'];
}

/** hold／stack 這一列有沒有帶還沒開放的附加設定；回傳設定名稱（沒有就是空陣列）。 */
export function rowExtras(row: Pick<Row, 'play' | 'p'>): string[] {
  const p = row.p as Record<string, unknown>;
  const extras: string[] = [];
  if (row.play === 'hold' && p.venue !== undefined && p.venue !== 'hold') extras.push('Earn while held');
  if ((row.play === 'hold' || row.play === 'stack') && p.exit !== undefined && p.exit !== 'none') extras.push('Take profit or stop loss');
  if (row.play === 'stack' && typeof p.ceiling === 'number' && p.ceiling > 0) extras.push('Pause buying above a price');
  return extras;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * 設計器的 stack 欄位換成後端的 UTC 排程。設計器的時刻是創作者這台裝置的當地時間、星期 0 是星期一；
 * 後端要 UTC、星期 0 是星期日。以 `now` 那週換算（換算後可能跨到前一天或後一天，星期跟著變）；
 * 固定成 UTC 之後，遇到夏令時間切換，當地看到的時刻會差一小時（後端契約已寫明）。
 * 不是每天／每週、期數不在 2–52、時刻格式不對：回傳 null。
 */
export function stackExecution(
  p: { every: string; day?: number; time?: string; buys: number },
  now: Date = new Date(),
): StackExecution | null {
  if (p.every !== 'daily' && p.every !== 'weekly') return null;
  if (!Number.isInteger(p.buys) || p.buys < STACK_SLICES.min || p.buys > STACK_SLICES.max) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(p.time ?? '09:00');
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  // 先定位目標日期（用中午，避開夏令時間切換那一小時），再設時刻（cre8-app#93）。
  // 以前先在今天設 02:30，遇到今天沒有 02:30（春季撥快）會被正規化成 03:30，再搬到星期一就錯一小時。
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  if (p.every === 'weekly') {
    const weekday = p.day ?? 0;
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
    const target = (weekday + 1) % 7;
    day.setDate(day.getDate() + ((target - day.getDay() + 7) % 7));
  }
  // 那一天的這個當地時刻不存在（撥快跳過）或出現兩次（撥慢重複）：往後找下一個（每天＋1 天、每週＋7 天）時刻清楚的日子。
  const step = p.every === 'weekly' ? 7 : 1;
  let local = localTimeOn(day, hour, minute);
  for (let tries = 0; local === null && tries < 4; tries += 1) {
    day.setDate(day.getDate() + step);
    local = localTimeOn(day, hour, minute);
  }
  if (local === null) return null;
  return {
    kind: 'stack',
    every: p.every,
    weekday: p.every === 'weekly' ? local.getUTCDay() : null,
    timeUtc: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
    slices: p.buys,
  };
}

/** 那一天的當地 `hour:minute`；不存在或有兩個（夏令時間切換）回 null。 */
function localTimeOn(day: Date, hour: number, minute: number): Date | null {
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
  if (at.getHours() !== hour || at.getMinutes() !== minute || at.getDate() !== day.getDate()) return null; // 被跳過
  const later = new Date(at.getTime() + 3_600_000);
  if (later.getHours() === hour && later.getMinutes() === minute) return null; // 撥慢：一小時後又是同一個時刻
  const earlier = new Date(at.getTime() - 3_600_000);
  if (earlier.getHours() === hour && earlier.getMinutes() === minute) return null;
  return at;
}

/**
 * 設計換成逐資產設定。沒有資產的設計（全部 USDT）也可以：USDT 沒有執行設定。
 * 檢查順序：還沒開放的策略 → 附加設定 → stack 排程 → 同資產兩種設定，一次只講一件要改的事。
 */
export function designExecution(
  rows: readonly Pick<Row, 'key' | 'play' | 'p'>[],
  options: {
    rules?: Partial<Record<Exclude<keyof FundRules, 'rebalance'>, { on: boolean }>> & { rebalance?: RebalanceRule };
    playName?: (play: string) => string;
    assetName?: (key: string) => string;
    open?: readonly ExecutionKind[];
    now?: Date;
  } = {},
): DesignExecution {
  const { rules = {}, playName = (play) => play, assetName = (key) => key, open = openKinds(), now = new Date() } = options;
  const excluded = [...new Set(rows.filter((row) => !open.includes(row.play as ExecutionKind)).map((row) => playName(row.play)))];
  if (excluded.length > 0) return { problem: { kind: 'excluded', plays: excluded } };
  const extras = [...new Set(rows.flatMap(rowExtras))];
  // 再平衡以外的整檔規則（留強、配對網格、整檔停損、閒置生息）都還沒開放。
  if (Object.entries(rules).some(([key, rule]) => key !== 'rebalance' && rule?.on)) extras.push('Whole-fund rules');
  if (extras.length > 0) return { problem: { kind: 'extras', settings: extras } };
  const each = rows.map((row) => ({
    key: row.key,
    execution: row.play === 'stack' ? stackExecution(row.p as { every: string; day?: number; time?: string; buys: number }, now) : ({ kind: 'hold' } as AssetExecution),
  }));
  const badSchedule = [...new Set(each.filter((item) => item.execution === null).map((item) => assetName(item.key)))];
  if (badSchedule.length > 0) return { problem: { kind: 'schedule', assets: badSchedule } };
  const assets = new Map<string, AssetExecution>();
  const split = new Set<string>();
  for (const item of each) {
    const seen = assets.get(item.key);
    if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(item.execution)) split.add(assetName(item.key));
    else assets.set(item.key, item.execution as AssetExecution);
  }
  if (split.size > 0) return { problem: { kind: 'split', assets: [...split] } };
  const rebalance = rebalanceOf(rules.rebalance);
  if (rebalance === null) return { problem: { kind: 'rebalance', reason: 'options' } };
  if (rebalance !== 'none' && [...assets.values()].some((setting) => setting.kind === 'stack')) return { problem: { kind: 'rebalance', reason: 'stack' } };
  return { assets, rebalance };
}

const list = (names: string[]): string => names.join(', ');
const isAre = (names: string[]): string => (names.length === 1 ? 'is' : 'are');
const itThem = (names: string[]): string => (names.length === 1 ? 'it' : 'them');

/** 給畫面的一句話：要先改什麼。 */
export function describeExecutionProblem(problem: ExecutionProblem, open: readonly ExecutionKind[] = openKinds()): string {
  const switchTo = open.map((kind) => EXECUTION_COPY[kind].name).join(' or ');
  switch (problem.kind) {
    case 'excluded':
      return `${list(problem.plays)} ${isAre(problem.plays)} coming soon. Switch ${itThem(problem.plays)} to ${switchTo} to activate this fund now.`;
    case 'extras':
      return `${list(problem.settings)} ${isAre(problem.settings)} coming soon. Turn ${itThem(problem.settings)} off to activate this fund now.`;
    case 'schedule':
      return `Stack buys daily or weekly, in ${STACK_SLICES.min}–${STACK_SLICES.max} buys. Change the schedule of ${list(problem.assets)} to activate this fund now.`;
    case 'split':
      return `${list(problem.assets)} ${problem.assets.length === 1 ? 'has' : 'have'} two different strategies. Give each asset one strategy to activate this fund now.`;
    case 'rebalance':
      return problem.reason === 'stack'
        ? `${REBALANCE_STACK_NOTE} Turn rebalancing off, or set every asset to Buy & hold, to activate this fund now.`
        : `Rebalancing runs monthly or when an asset is more than ${REBALANCE_DRIFT_POINTS} points off its share, back to your shares. Pick one of those to activate this fund now.`;
  }
}

/** 兩種策略給人看的名稱與說明（設計器、建立頁、確認框共用）。 */
export const EXECUTION_COPY: Record<ExecutionKind, { name: string; short: string; sentence: string; line: string; confirm: string }> = {
  hold: {
    name: 'Buy & hold',
    short: 'Bought with each deposit and kept.',
    sentence: ', bought with each new deposit and kept.',
    line: 'Its share of each new deposit is bought at the next buying window and kept. It is only sold if the fund rebalances.',
    confirm: 'I understand: each new deposit is bought at these weights and kept. CRE8 does not sell or rebalance it when prices move.',
  },
  stack: {
    name: 'Stack',
    short: 'Bought in daily or weekly slices of each deposit.',
    sentence: ', bought in equal daily or weekly slices of each deposit.',
    line: 'You set how often (daily or weekly), when, and how many buys each deposit is split into. Holders only choose how much to put in. A buy without enough USDT is skipped, not made up later.',
    confirm: 'I understand: the Stack assets are bought in the daily or weekly slices I set. A buy without enough USDT is skipped, and nothing is sold when prices move.',
  },
};

/** 有資產是 Stack 時不能再平衡的原因（設計器與錯誤訊息共用）。 */
export const REBALANCE_STACK_NOTE = 'Rebalancing needs every asset on Buy & hold: a Stack asset is still being bought in slices.';

/** 三個再平衡選項給人看的名稱與一句說明。 */
export const REBALANCE_COPY: Record<Rebalance, { name: string; line: string }> = {
  none: { name: 'Off', line: 'Nothing is sold when prices move.' },
  monthly: { name: 'Monthly', line: 'Once a month (UTC), assets above their share are sold and those below are bought, back to your shares.' },
  drift: { name: `More than ${REBALANCE_DRIFT_POINTS} points off`, line: `When any asset is more than ${REBALANCE_DRIFT_POINTS} points off its share, the fund sells what is above and buys what is below, back to your shares.` },
};

const LOCAL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** 一個 stack 資產的排程，換回這台裝置的當地時間講給人看：「Every Monday at 09:00 your time, over 12 buys」。 */
export function stackWords(stack: StackExecution, now: Date = new Date()): string {
  const [hours, minutes] = stack.timeUtc.split(':').map(Number) as [number, number];
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes));
  if (stack.every === 'weekly') at.setUTCDate(at.getUTCDate() + (((stack.weekday ?? 0) - at.getUTCDay() + 7) % 7));
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${stack.every === 'daily' ? 'Every day' : `Every ${LOCAL_DAYS[at.getDay()]}`} at ${time} your time, over ${stack.slices} buys`;
}

/** 建立頁的確認句：只講這檔基金真的有的那幾種。 */
export function executionConfirm(kinds: ReadonlySet<ExecutionKind>, rebalance: Rebalance = 'none'): string {
  if (rebalance !== 'none') return `I understand: each new deposit is bought at these weights, and ${rebalance === 'monthly' ? 'once a month' : `when an asset is more than ${REBALANCE_DRIFT_POINTS} points off its share`} CRE8 sells and buys to bring every asset back to its share.`;
  if (!kinds.has('stack')) return EXECUTION_COPY.hold.confirm;
  if (!kinds.has('hold')) return EXECUTION_COPY.stack.confirm;
  return 'I understand: Buy & hold assets are bought with each deposit and kept, and Stack assets in the daily or weekly slices I set. A buy without enough USDT is skipped, and CRE8 does not sell or rebalance when prices move.';
}

export type VersionAsset ={ address: string; weightBps: number; execution?: AssetExecution };

/** 送給後端的逐資產設定（USDT 那一項沒有 execution）。 */
type ExecutionEntry = { asset: string; weightBps: number; execution?: AssetExecution; yield: null };

/** `POST /strategies/:id/versions` 的本文（schema 2，backend BE-2）。 */
export type TypedVersionBody = {
  chainId: number;
  allocation: { assets: { address: string; weightBps: number }[] };
  execution: { kind: 'per_asset'; numeraire: string; rebalance: Rebalance; assets: ExecutionEntry[] };
  schedule: { kind: 'funding' };
  idleYield: { enabled: false };
  changeLog?: string;
};

/**
 * 組出要送的版本。地址一律小寫（後端逐字比對 numeraire）。USDT 一定列出來（沒選就是 0%）：後端會把它補進
 * allocation，execution 要一項一項對得上。非 USDT 資產的設定一定明寫（沒給就是 hold）；USDT 不能有 execution。
 * 再平衡預設不做（none；只有全部 hold 才能 monthly／drift）、生息關閉（APP-3 之前不開）、排程固定是 `funding`（依投入觸發）。
 */
export function typedVersionBody(input: { chainId: number; usdt: string; assets: VersionAsset[]; rebalance?: Rebalance; changeLog?: string }): TypedVersionBody {
  const rebalance = input.rebalance ?? 'none';
  if (rebalance !== 'none' && input.assets.some((asset) => asset.execution?.kind === 'stack')) throw new Error(REBALANCE_STACK_NOTE);
  const usdt = input.usdt.toLowerCase();
  const total = input.assets.reduce((sum, asset) => sum + asset.weightBps, 0);
  if (total !== 10_000) throw new Error(`Weights add up to ${total / 100}%, not 100%.`);
  const assets = input.assets.map((asset) => ({ ...asset, address: asset.address.toLowerCase() }));
  if (new Set(assets.map((asset) => asset.address)).size !== assets.length) throw new Error('An asset is listed twice.');
  const cash = assets.find((asset) => asset.address === usdt);
  if (cash?.execution !== undefined && cash.execution.kind !== 'hold') throw new Error('USDT is held as cash; it cannot be stacked.');
  const all: VersionAsset[] = cash === undefined ? [...assets, { address: usdt, weightBps: 0 }] : assets;
  return {
    chainId: input.chainId,
    allocation: { assets: all.map((asset) => ({ address: asset.address, weightBps: asset.weightBps })) },
    execution: {
      kind: 'per_asset',
      numeraire: usdt,
      rebalance,
      assets: all.map((asset) => asset.address === usdt
        ? { asset: asset.address, weightBps: asset.weightBps, yield: null }
        : { asset: asset.address, weightBps: asset.weightBps, execution: asset.execution ?? { kind: 'hold' }, yield: null }),
    },
    schedule: { kind: 'funding' },
    idleYield: { enabled: false },
    ...(input.changeLog === undefined ? {} : { changeLog: input.changeLog }),
  };
}

/**
 * 最低投入（USDT，含費用）：每批至少 50，現金部分不換幣，所以要用非現金比例放大（50% 現金至少 100）。
 * 跟後端 `minimumAssetContribution` 同一個算法；實際以後端回的數字為準（投入頁會讀）。
 */
export function minimumDeposit(assets: readonly { address: string; weightBps: number }[], usdt: string): number {
  const invested = assets.filter((asset) => asset.address.toLowerCase() !== usdt.toLowerCase()).reduce((sum, asset) => sum + asset.weightBps, 0);
  return invested === 0 ? 50 : Math.ceil((50 * 10_000) / invested * 100) / 100;
}

/** 百分比換成 bps（0.01%）。輸入框與送出用同一個換算（cre8-app#93）。 */
export const percentToBps = (percent: number): number => Math.round(percent * 100);
/** 輸入的百分比先量化到 0.01%，畫面看到的就是會送出的。 */
export const quantizePercent = (percent: number): number => percentToBps(Math.max(0, Math.min(100, percent))) / 100;

/**
 * 有填權重、換成 bps 卻是 0 的非現金資產（例如 0.001%）。四捨五入後合計仍可能剛好 10000，
 * 但 0 bps 的資產後端會拒絕，要在建立策略之前就擋下。
 */
export function zeroBpsAssets(weights: readonly (readonly [string, number])[], usdt: string): string[] {
  return weights
    .filter(([address, percent]) => address.toLowerCase() !== usdt.toLowerCase() && percent > 0 && percentToBps(percent) < 1)
    .map(([address]) => address);
}
