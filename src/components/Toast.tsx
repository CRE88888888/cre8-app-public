import { create } from 'zustand';
import type { ReactNode } from 'react';

/**
 * 全域 toast：交易這種**跨越好幾秒、好幾個簽章**的動作，需要一個「現在進行到哪」的出口。
 *
 * 為什麼不是就地顯示：交易狀態是「已送出 → 等待簽章 → 已上鏈」，每一步都可能發生在
 * 使用者把視線移開之後（簽完名順手切回錢包）。就地訊息要等他切回來才看到；
 * toast 是「發生時就在那裡」。
 *
 * 刻意不做：queue、堆疊上限以外的排序。同時最多三則，多的擠掉最舊的。
 */

export type ToastTone = 'pending' | 'ok' | 'warn' | 'bad';

export type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  /** 第二行（tx hash、金額、原因）。 */
  body?: string;
};

type ToastState = {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
  replace: (id: number, toast: Omit<Toast, 'id'>) => number;
};

/** 同時最多三則 —— 四個以上就沒人會讀了。 */
const MAX_VISIBLE = 3;

/** `pending` 不自動消失：它要等 `replace` 換成結果，否則會留下一個永遠在轉的圈。 */
const TTL: Record<ToastTone, number | null> = { pending: null, ok: 8_000, warn: 12_000, bad: 15_000 };

let nextId = 1;

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId;
    nextId += 1;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }].slice(-MAX_VISIBLE) }));
    const ttl = TTL[toast.tone];
    if (ttl !== null) window.setTimeout(() => get().dismiss(id), ttl);
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== id) })),
  replace: (id, toast) => {
    get().dismiss(id);
    return get().push(toast);
  },
}));

/** 給非 React 的呼叫端（`catch` 裡、async 流程中）用。 */
export const toast = {
  pending: (title: string, body?: string): number => useToasts.getState().push({ tone: 'pending', title, body }),
  ok: (title: string, body?: string): number => useToasts.getState().push({ tone: 'ok', title, body }),
  warn: (title: string, body?: string): number => useToasts.getState().push({ tone: 'warn', title, body }),
  bad: (title: string, body?: string): number => useToasts.getState().push({ tone: 'bad', title, body }),
  replace: (id: number, next: Omit<Toast, 'id'>): number => useToasts.getState().replace(id, next),
  dismiss: (id: number): void => useToasts.getState().dismiss(id),
};

// DEV 自測：`?toast=1` 時在**模組載入**就推一則（不放在 effect 裡）。
// 這樣可以分辨「元件沒掛上」與「effect 沒跑」—— 模組載入一定比任何 render 早。
if (import.meta.env.DEV && typeof window !== 'undefined') {
  if (new URLSearchParams(window.location.search).get('toast') !== null) {
    window.setTimeout(() => toast.warn('Toast self-test', 'module-load path'), 0);
  }
}

const TONE_LABEL: Record<ToastTone, string> = { pending: 'Pending', ok: 'Done', warn: 'Note', bad: 'Failed' };

/** 掛在 App 最外層一次。 */
export function Toaster(): ReactNode {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div className="app-toast-stack" role="status" aria-live="polite">
      {toasts.map((entry) => (
        <div key={entry.id} className={`app-toast app-toast--${entry.tone}`}>
          <div className="app-toast-head">
            <span className="app-toast-tone">{TONE_LABEL[entry.tone]}</span>
            <button type="button" className="app-toast-x" aria-label="Dismiss" onClick={() => dismiss(entry.id)}>
              ×
            </button>
          </div>
          <strong className="app-toast-title">{entry.title}</strong>
          {entry.body === undefined ? null : <span className="app-toast-body mono">{entry.body}</span>}
        </div>
      ))}
    </div>
  );
}
