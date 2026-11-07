import { ApiError } from './api.js';

export type LogLevel = 'step' | 'ok' | 'fail' | 'value' | 'info';

/** bigint / Error / 巢狀物件都要能印得出來，且不吞任何原文。 */
export function format(value: unknown): string {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return errorText(value);
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v), 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 錯誤原文。這個 app 的存在意義就是看錯誤訊息，所以 API 錯誤會連 raw body 一起印，
 * 其他錯誤連 stack 一起印 —— 不做任何「發生錯誤」式的摘要。
 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const parts = [`${err.name}: ${err.message}`];
    if (err.status > 0) parts.push(`HTTP ${err.status}${err.code ? ` / code=${err.code}` : ''}`);
    if (err.raw !== undefined && err.raw !== '') parts.push(`raw body: ${err.raw}`);
    return parts.join('\n');
  }
  if (err instanceof Error) {
    const head = `${err.name}: ${err.message}`;
    if (!err.stack) return head;
    // stack 第一行就是 "Name: message"，已經印過就不再重複。
    const frames = err.stack.split('\n');
    const rest = frames[0]?.includes(err.message) ? frames.slice(1) : frames;
    return [head, ...rest].join('\n').trimEnd();
  }
  return format(err);
}

const PREFIX: Record<LogLevel, string> = {
  step: '▸',
  ok: '✔',
  fail: '✘',
  value: '  ',
  info: '·',
};

/** 把每一步寫進頁面上的 <pre>，並帶明確狀態（進行中 / 成功 / 失敗）。 */
export class Trace {
  readonly #out: HTMLElement;

  constructor(out: HTMLElement) {
    this.#out = out;
  }

  clear(): void {
    this.#out.textContent = '';
  }

  #line(level: LogLevel, text: string): void {
    const line = document.createElement('span');
    line.className = `l${level}`;
    line.textContent = `${PREFIX[level]} ${text}\n`;
    if (this.#out.textContent === '' || this.#out.textContent === '— 尚未有動作 —') {
      this.#out.textContent = '';
    }
    this.#out.appendChild(line);
    this.#out.scrollTop = this.#out.scrollHeight;
  }

  step(name: string): void {
    this.#line('step', `${name} … 進行中`);
  }

  ok(name: string, detail?: unknown): void {
    this.#line('ok', detail === undefined ? name : `${name} — ${format(detail)}`);
  }

  fail(name: string, err: unknown): void {
    this.#line('fail', `${name} 失敗\n${errorText(err)}`);
  }

  value(label: string, value: unknown): void {
    this.#line('value', `${label} = ${format(value)}`);
  }

  info(msg: string): void {
    this.#line('info', msg);
  }

  raw(label: string, payload: unknown): void {
    this.#line('info', `${label}: ${format(payload)}`);
  }
}

/** 單一步驟的狀態機，讓每個按鈕都有自己的「進行中 / 成功 / 失敗」。 */
export function setBadge(el: HTMLElement, state: 'idle' | 'run' | 'ok' | 'fail', text?: string): void {
  el.className = `badge${state === 'idle' ? '' : ` ${state}`}`;
  el.textContent = text ?? { idle: '未開始', run: '進行中', ok: '成功', fail: '失敗' }[state];
}
