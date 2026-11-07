import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad';

const TONE_CLASS: Record<Tone, string> = {
  neutral: '',
  ok: 'badge--ok',
  warn: 'badge--warn',
  bad: 'badge--bad',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return <span className={`badge ${TONE_CLASS[tone]}`.trim()}>{children}</span>;
}

export function Spinner(): ReactNode {
  return <span className="spinner" role="status" aria-label="載入中" />;
}

export function Note({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'bad' | 'warn';
  children: ReactNode;
}): ReactNode {
  const cls = tone === 'neutral' ? 'note' : `note note--${tone}`;
  return <div className={cls}>{children}</div>;
}

/**
 * 錯誤顯示。**刻意把 `code` 與 HTTP status 一起秀出來**：
 * 「後端開關沒開」與「後端壞了」是兩種完全不同的處置，而訊息長得一樣時人只會看到紅字。
 */
export function ErrorNote({ error }: { error: unknown }): ReactNode {
  if (error === null || error === undefined) return null;

  if (error instanceof ApiError) {
    const detail =
      error.status === 0
        ? '後端連不上（服務沒開或 proxy 沒設對）'
        : error.status === 401
          ? 'token 失效或沒有帶上 —— 請重新登入'
          : error.status === 403
            ? '後端拒絕：這是權限或開關問題，不是一般錯誤'
            : error.status === 404
              ? '找不到（portfolio id 或路徑不對）'
              : error.status === 503
                ? '後端暫時無法回答（可能是 RPC 或 DB 讀不到）'
                : '後端回報錯誤';
    return (
      <Note tone="bad">
        <strong>
          {error.status === 0 ? 'NETWORK' : `${error.status} · ${error.code}`}
        </strong>
        <div style={{ marginTop: 6 }}>{error.message}</div>
        <div style={{ marginTop: 6, opacity: 0.75 }}>{detail}</div>
      </Note>
    );
  }

  return (
    <Note tone="bad">
      <strong>未預期的錯誤</strong>
      <div style={{ marginTop: 6 }}>{error instanceof Error ? error.message : String(error)}</div>
    </Note>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint === undefined ? null : <span className="field__hint">{hint}</span>}
    </div>
  );
}
