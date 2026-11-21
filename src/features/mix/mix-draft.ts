/**
 * 正在建立（或修改）的 My mix（cre8-app#132）。放在 sessionStorage：要登入才能買時，
 * 登入回來草稿還在，不用重選。
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mixAsset } from './mix-catalog';
import { MAX_ASSETS, equalWeights, setWeight, stepWeight } from './mix-math';
import type { CreateMixInput, Exit, Frequency, MixAsset, Rebalance } from './mix-types';

export type MixDraft = {
  symbols: string[];
  weights: number[];
  /** 金額輸入框的文字。 */
  amount: string;
  /** 空字串＝自動產生。 */
  name: string;
  frequency: Frequency;
  /** 空字串＝今天。 */
  startDate: string;
  /** 停利／停損，萬分比整數（3000 = +30%），和後端同單位，不經過小數；null＝Off。 */
  upBps: number | null;
  downBps: number | null;
  /** 從分享連結來的：分享代碼與原本的名稱。 */
  importCode: string | null;
  sourceName: string | null;
  /** Change mix：改哪一個組合（null＝新建）。 */
  editingId: number | null;
  /** Change mix：開始改之前的設定。送出時只送有改的欄位。 */
  base: { name: string; rebalance: Rebalance; exit: Exit } | null;
  /**
   * 這次建立用的 Idempotency-Key 與它對應的 body（C3 審查第 3 點）：跟草稿一起存在 sessionStorage，
   * 重整、登入跳轉回來重送時沿用，不會多建一個組合；body 變了才換新 key；建好清掉。
   */
  creation: { body: string; key: string } | null;
};

type Actions = {
  toggle: (symbol: string) => 'added' | 'removed' | 'full';
  step: (index: number, direction: 1 | -1) => void;
  setWeightAt: (index: number, bps: number) => void;
  set: (patch: Partial<MixDraft>) => void;
  reset: (patch?: Partial<MixDraft>) => void;
};

export const EMPTY_DRAFT: MixDraft = {
  symbols: [], weights: [], amount: '', name: '', frequency: 'monthly', startDate: '',
  upBps: null, downBps: null, importCode: null, sourceName: null, editingId: null, base: null, creation: null,
};

export const useMixDraft = create<MixDraft & Actions>()(
  persist(
    (set, get) => ({
      ...EMPTY_DRAFT,
      toggle: (symbol) => {
        const { symbols } = get();
        if (symbols.includes(symbol)) {
          const next = symbols.filter((s) => s !== symbol);
          // 拿掉一個就回到平均：用戶還在挑，不需要保留舊比例。
          set({ symbols: next, weights: equalWeights(next.length), importCode: null });
          return 'removed';
        }
        if (symbols.length >= MAX_ASSETS) return 'full';
        const next = [...symbols, symbol];
        set({ symbols: next, weights: equalWeights(next.length), importCode: null });
        return 'added';
      },
      // 動了比例就不是分享來的那一組了：清掉 importCode，改送 assets（C3 審查第 2 點）。
      step: (index, direction) => set({ weights: stepWeight(get().weights, index, direction), importCode: null }),
      setWeightAt: (index, bps) => set({ weights: setWeight(get().weights, index, bps), importCode: null }),
      set: (patch) => set(patch),
      reset: (patch = {}) => set({ ...EMPTY_DRAFT, ...patch }),
    }),
    { name: 'cre8.mixDraft', storage: createJSONStorage(() => sessionStorage) },
  ),
);

export function draftAssets(draft: Pick<MixDraft, 'symbols' | 'weights'>): MixAsset[] {
  return draft.symbols.flatMap((symbol, index) => {
    const asset = mixAsset(symbol);
    return asset === undefined ? [] : [{ assetId: asset.address, weightBps: draft.weights[index] ?? 0 }];
  });
}

/** 送出的停利停損（新建）。 */
export function draftExit(draft: Pick<MixDraft, 'upBps' | 'downBps'>): Exit {
  return { takeProfitBps: draft.upBps, stopLossBps: draft.downBps };
}

/** 新建組合的 body：分享來的、比例沒動過就送 importCode（後端照來源成分），否則送 assets。 */
export function createBody(draft: MixDraft, name: string, today: string): CreateMixInput {
  const settings = {
    name,
    rebalance: { frequency: draft.frequency, startDate: draft.startDate || today },
    exit: draftExit(draft),
  };
  return draft.importCode !== null ? { ...settings, importCode: draft.importCode } : { ...settings, assets: draftAssets(draft) };
}

/**
 * Change mix 的 PATCH body：只送有改的欄位（沒改的停利停損、頻率、開始日一律不送，免得舊的開始日被當成過去日期擋下）。
 * 成分或比例有變才帶 assets（之後要簽名）。
 */
export function editBody(draft: MixDraft, name: string, assetsChanged: boolean): CreateMixInput {
  const base = draft.base;
  const body: CreateMixInput = {};
  if (base === null || name !== base.name) body.name = name;
  const rebalance: Partial<Rebalance> = {};
  if (base === null || draft.frequency !== base.rebalance.frequency) rebalance.frequency = draft.frequency;
  if (draft.startDate !== '' && (base === null || draft.startDate !== base.rebalance.startDate)) rebalance.startDate = draft.startDate;
  if (Object.keys(rebalance).length > 0) body.rebalance = rebalance;
  const exit: Partial<Exit> = {};
  if (base === null || draft.upBps !== base.exit.takeProfitBps) exit.takeProfitBps = draft.upBps;
  if (base === null || draft.downBps !== base.exit.stopLossBps) exit.stopLossBps = draft.downBps;
  if (Object.keys(exit).length > 0) body.exit = exit;
  if (assetsChanged) body.assets = draftAssets(draft);
  return body;
}

/** 這次建立要用的 Idempotency-Key：body 跟上次一樣就沿用（存在草稿裡，重整也在），不一樣才換新的。 */
export function creationKey(body: CreateMixInput, newKey: () => string): string {
  const json = JSON.stringify(body);
  const current = useMixDraft.getState().creation;
  if (current !== null && current.body === json) return current.key;
  const key = newKey();
  useMixDraft.getState().set({ creation: { body: json, key } });
  return key;
}
