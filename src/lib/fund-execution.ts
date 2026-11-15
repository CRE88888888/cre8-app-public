/**
 * 基金版本的執行模式（cre8-app#79，APP-1）：純持有（hold）或定期定額（stack）。
 *
 * 規格：docs `research/2026-11-15-strategies-spec.zh-TW.md` §5、§6；G0 決定：一個基金版本統一選 hold 或 stack，
 * 全部非現金成分共用；舊草稿的混合規則要提示修改，不能悄悄降級。後端契約：backend `docs/strategy-api.zh-TW.md`。
 *
 * 設計器每個資產各有一種 play（參考設計的資料結構，不能改）。這裡把它收斂成整檔基金的一種模式，
 * 收斂不了就回傳要使用者先改什麼。草稿本身一個欄位都不刪（舊設定留著，之後開放時還在）。
 * 純邏輯：不碰 React、不碰 fetch。
 */
import type { FundRules, Row } from '../reference/lib/fund-builder';
import { playLock } from './feature-flags';

export type ExecutionKind = 'hold' | 'stack';

/** 設計裡擋住啟用的原因。`plays` 是要改的那幾種策略或設定的名稱（給畫面列出來）。 */
export type ExecutionProblem =
  /** 有些資產是 hold、有些是 stack。 */
  | { kind: 'mixed' }
  /** 用了還沒開放的策略（custom、dips、range、trend、lp、carry）。 */
  | { kind: 'excluded'; plays: string[] }
  /** hold／stack 帶了還沒開放的附加設定（持有期間出借、停利停損、價格上限、整檔規則）。 */
  | { kind: 'extras'; settings: string[] };

export type DesignExecution = { kind: ExecutionKind } | { problem: ExecutionProblem };

/** 這次可以啟用的模式：hold 一直開著；stack 跟功能開關 `strategyDca`（後端支援創作者的定期參數之前是 Coming soon）。 */
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

/**
 * 設計收斂成哪一種模式。沒有資產的設計（全部 USDT）算 hold：後端允許純 USDT 的 hold，不允許純 USDT 的 stack。
 * 檢查順序：先擋還沒開放的策略，再擋混合，最後擋附加設定，一次只講一件要改的事。
 */
export function designExecution(
  rows: readonly Pick<Row, 'play' | 'p'>[],
  rules: Partial<Record<keyof FundRules, { on: boolean }>> = {},
  playName: (play: string) => string = (play) => play,
  open: readonly ExecutionKind[] = openKinds(),
): DesignExecution {
  const excluded = [...new Set(rows.filter((row) => !open.includes(row.play as ExecutionKind)).map((row) => playName(row.play)))];
  if (excluded.length > 0) return { problem: { kind: 'excluded', plays: excluded } };
  const kinds = new Set(rows.map((row) => row.play as ExecutionKind));
  if (kinds.size > 1) return { problem: { kind: 'mixed' } };
  const extras = [...new Set(rows.flatMap(rowExtras))];
  // 整檔規則（再平衡、留強、配對網格、整檔停損、閒置生息）都還沒開放：hold 不再平衡，stack 只照比例買。
  if (Object.values(rules).some((rule) => rule?.on)) extras.push('Whole-fund rules');
  if (extras.length > 0) return { problem: { kind: 'extras', settings: extras } };
  return { kind: kinds.has('stack') ? 'stack' : 'hold' };
}

/** 給畫面的一句話：要先改什麼。 */
export function describeExecutionProblem(problem: ExecutionProblem, open: readonly ExecutionKind[] = openKinds()): string {
  const switchTo = open.map((kind) => EXECUTION_COPY[kind].name).join(' or ');
  switch (problem.kind) {
    case 'mixed':
      return 'A fund runs one way: set every asset to Buy & hold, or every asset to Stack.';
    case 'excluded':
      return `${problem.plays.join(', ')} ${problem.plays.length === 1 ? 'is' : 'are'} coming soon. Switch ${problem.plays.length === 1 ? 'it' : 'them'} to ${switchTo} to activate this fund now.`;
    case 'extras':
      return `${problem.settings.join(', ')} ${problem.settings.length === 1 ? 'is' : 'are'} coming soon. Turn ${problem.settings.length === 1 ? 'it' : 'them'} off to activate this fund now.`;
  }
}

/** 兩種模式給人看的名稱與一句說明（設計器、建立頁、確認框共用）。 */
export const EXECUTION_COPY: Record<ExecutionKind, { name: string; short: string; sentence: string; line: string; confirm: string }> = {
  hold: {
    name: 'Buy & hold',
    short: 'Bought with each deposit and kept.',
    sentence: ', bought with each new deposit and kept.',
    line: 'Each new deposit is bought at the fund’s weights and kept. Nothing is sold or rebalanced when prices move.',
    confirm: 'I understand: each new deposit is bought at these weights and kept. CRE8 does not sell or rebalance it when prices move.',
  },
  stack: {
    name: 'Stack',
    short: 'Bought in daily or weekly slices of each deposit.',
    sentence: ', bought in equal daily or weekly slices of each deposit.',
    line: 'You set how often (daily or weekly) and what share of each deposit is bought each time. Holders only choose how much to put in. A buy without enough USDT is skipped, not made up later.',
    confirm: 'I understand: each deposit is bought in the daily or weekly slices I set. A buy without enough USDT is skipped, and nothing is sold when prices move.',
  },
};

export type AllocationAsset = { address: string; weightBps: number };

/** `POST /strategies/:id/versions` 的本文（typed 版本，backend BE-1）。 */
export type TypedVersionBody = {
  chainId: number;
  allocation: { assets: AllocationAsset[] };
  execution: { kind: ExecutionKind };
  schedule: { kind: 'funding' };
  idleYield: { enabled: false };
  changeLog?: string;
};

/**
 * 組出要送的版本。模式一定明寫（不靠後端的預設補 hold），排程固定是 `funding`（依投入或個人期次觸發，
 * 不是再平衡間隔），閒置生息關閉（APP-3 之前不開）。stack 不能是純 USDT：後端會拒絕，這裡先擋。
 */
export function typedVersionBody(input: {
  chainId: number;
  kind: ExecutionKind;
  assets: AllocationAsset[];
  usdt: string;
  changeLog?: string;
}): TypedVersionBody {
  const total = input.assets.reduce((sum, asset) => sum + asset.weightBps, 0);
  if (total !== 10_000) throw new Error(`Weights add up to ${total / 100}%, not 100%.`);
  if (input.kind === 'stack' && input.assets.every((asset) => asset.weightBps === 0 || asset.address.toLowerCase() === input.usdt.toLowerCase())) {
    throw new Error('Stack needs at least one asset besides USDT.');
  }
  return {
    chainId: input.chainId,
    allocation: { assets: input.assets.map((asset) => ({ address: asset.address.toLowerCase(), weightBps: asset.weightBps })) },
    execution: { kind: input.kind },
    schedule: { kind: 'funding' },
    idleYield: { enabled: false },
    ...(input.changeLog === undefined ? {} : { changeLog: input.changeLog }),
  };
}
