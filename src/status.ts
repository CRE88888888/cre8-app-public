/**
 * 「投組狀態」面板：`GET /portfolios/:id/status` 的渲染 ＋ 再平衡的確認步驟與結果。
 *
 * 兩條不能讓步的規則（就是這個面板存在的理由）：
 *   1. 讀不到狀態時**只印原文**、一個漂流數字都不畫。畫成「漂移 0 / 不需要再平衡」會讓人
 *      以為投組很好，然後錯過真正該做的事（重開 RPC / 修 fork）。
 *   2. 會動錢的 POST 一定先過確認步驟：按「觸發再平衡」只展開確認，不送任何請求。
 *
 * 這裡只做 DOM 與 fetch；所有「這段文字該長什麼樣」在 status-format.ts（那裡沒有 DOM，
 * 可以用 bun 直接餵 payload 驗算）。
 */
import * as api from './api.js';
import { ApiError } from './api.js';
import type { Trace } from './log.js';
import { format, setBadge } from './log.js';
import {
  ACTUAL_GAS_USED_FIELD,
  actualGasUsedLabel,
  assetRows,
  blockedLines,
  completenessWarning,
  confirmLines,
  driftLine,
  formatUsdE8,
  holdingRows,
  rebalanceFailureLines,
  rebalanceOutcomeMeta,
  sessionKeyLines,
  statusFailureLines,
  swapExecutedLabel,
  unpricedLines,
} from './status-format.js';
import type { ErrorLike } from './status-format.js';

export type StatusPanelOptions = {
  portfolioId: number | string;
  /** 面板掛載點（在 portfolio 那一列下面展開的 <td> 裡）。 */
  container: HTMLElement;
  trace: Trace;
  baseUrl: () => string;
  /** 每次請求才拿 token：登入重做之後面板要跟著換。null = 未登入。 */
  token: () => string | null;
};

// ---------------------------------------------------------------- DOM 小工具

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = make('button', className, label);
  button.addEventListener('click', onClick);
  return button;
}

function badgeSpan(state: 'idle' | 'run' | 'ok' | 'fail', text: string): HTMLElement {
  const badge = make('span');
  setBadge(badge, state, text);
  return badge;
}

function headRow(title: string, state: 'idle' | 'run' | 'ok' | 'fail', badgeText: string): HTMLElement {
  const row = make('div', 'pf-head');
  row.append(make('strong', '', title), badgeSpan(state, badgeText));
  return row;
}

function addKv(host: HTMLElement, term: string, value: string): void {
  host.append(make('dt', '', term), make('dd', '', value));
}

/** 警示框（原文逐行、mono）。 */
function failureBox(lines: string[]): HTMLElement {
  const box = make('div', 'warn');
  box.setAttribute('role', 'alert');
  for (const line of lines) box.append(make('p', 'mono', line));
  return box;
}

/** `403 OPERATOR_REBALANCE_DISABLED` 專用：長得跟一般錯誤不一樣，且保留後端原文。 */
function disabledBox(lines: string[]): HTMLElement {
  const box = make('div', 'warn disabled');
  box.setAttribute('role', 'alert');
  box.append(make('p', 'lfail', '403 · OPERATOR_REBALANCE_DISABLED —— 後端開關沒開，不是一般錯誤'));
  for (const line of lines) box.append(make('p', 'mono', line));
  return box;
}

function copyButton(text: string): HTMLButtonElement {
  const button = makeButton('複製', 'ghost copy-btn', () => {
    void (async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = '已複製';
      } catch {
        // 沒有 clipboard 權限（非 https / 使用者拒絕）：退回「選起來自己複製」，仍然不吞東西。
        window.prompt('複製 txHash：', text);
      }
      window.setTimeout(() => {
        button.textContent = '複製';
      }, 1500);
    })();
  });
  return button;
}

function toErrorLike(err: unknown): ErrorLike {
  if (err instanceof ApiError) {
    return { name: err.name, message: err.message, status: err.status, code: err.code, raw: err.raw };
  }
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: format(err) };
}

// ---------------------------------------------------------------- 進入點

/** 掛載就立刻抓一次狀態（「看狀態」按鈕按下去＝展開 + 抓一次）。 */
export function mountStatusPanel(options: StatusPanelOptions): void {
  options.container.replaceChildren();
  void loadStatus(options);
}

async function loadStatus(opts: StatusPanelOptions): Promise<void> {
  const { container, trace } = opts;
  const id = String(opts.portfolioId);
  container.replaceChildren(
    headRow(`投組狀態 · portfolio #${id}`, 'run', '讀取中'),
    make('p', 'hint', '讀取中…（後端要掃 Transfer 日誌、讀池子、定價，實測要幾秒）'),
  );

  const token = opts.token();
  if (token === null) {
    container.append(failureBox(['未登入：這支端點需要 Bearer token']));
    return;
  }

  trace.step(`GET /portfolios/${id}/status`);
  try {
    const status = await api.getPortfolioStatus(opts.baseUrl(), token, opts.portfolioId);
    trace.ok(`GET /portfolios/${id}/status`, {
      portfolioId: status.portfolioId,
      block: status.block,
      totalUsdE8: status.totalUsdE8,
      complete: status.complete,
      drift:
        status.drift === null
          ? null
          : {
              grossDriftBps: status.drift.grossDriftBps,
              thresholdBps: status.drift.thresholdBps,
              needsRebalance: status.drift.needsRebalance,
              maxAbsDeltaBps: status.drift.maxAbsDeltaBps,
            },
      blockedCount: status.blocked.length,
    });
    trace.raw(`status #${id} 原文`, status);
    renderStatus(opts, status);
  } catch (err) {
    trace.fail(`GET /portfolios/${id}/status`, err);
    renderStatusFailure(opts, err);
  }
}

// ---------------------------------------------------------------- 狀態

function renderStatusFailure(opts: StatusPanelOptions, err: unknown): void {
  const id = String(opts.portfolioId);
  opts.container.replaceChildren(
    headRow(`投組狀態 · portfolio #${id}`, 'fail', '讀取失敗'),
    failureBox(statusFailureLines(toErrorLike(err))),
  );
  const tools = make('div', 'status-tools');
  opts.container.append(tools);
  paintTools(opts, null, tools, make('div'));
}

function renderStatus(opts: StatusPanelOptions, status: api.PortfolioStatus): void {
  const { container } = opts;
  container.replaceChildren();

  container.append(
    headRow(
      `投組狀態 · portfolio #${String(status.portfolioId)}`,
      status.complete ? 'ok' : 'run',
      status.complete ? '完整' : '不完整',
    ),
  );

  container.append(
    make('p', 'hint', `block #${status.block}（這份狀態是在這個塊高觀測的快照）· account ${status.account}`),
  );

  const kv = make('dl', 'kv');
  addKv(
    kv,
    '總價值',
    status.totalUsdE8 === null
      ? '—（後端沒有回 totalUsdE8：沒有漂移報告）'
      : `${formatUsdE8(status.totalUsdE8)}　（totalUsdE8 = ${status.totalUsdE8}，1e8 定點）`,
  );
  addKv(kv, 'complete', status.complete ? 'true' : 'false');
  addKv(kv, 'block', `#${status.block}`);
  container.append(kv);

  // session key：DB 記的那把 vs 實際會用的那把。只顯示 DB 那一把會騙人（見 status-format）。
  for (const line of sessionKeyLines(status)) {
    container.append(make('p', `drift-line tone-${line.tone}`, line.text));
  }

  // 漂移：整份面板最重要的一行。
  const drift = driftLine(status);
  container.append(make('p', `drift-line tone-${drift.tone}`, drift.text));

  const warning = completenessWarning(status);
  const blocked = blockedLines(status);
  if (warning !== null || blocked.length > 0) {
    const box = make('div', 'warn');
    box.setAttribute('role', 'alert');
    if (warning !== null) box.append(make('p', '', `⚠ ${warning}`));
    if (blocked.length > 0) {
      box.append(make('p', '', `blocked（${String(blocked.length)} 筆）—— 後端因為這些原因算不出完整漂移：`));
      const list = make('ul', 'blocked-list');
      for (const line of blocked) list.append(make('li', 'mono', line));
      box.append(list);
    }
    container.append(box);
  }

  const unpriced = unpricedLines(status);
  if (unpriced.length > 0) {
    container.append(make('p', 'hint', `沒有可用價格的資產（${String(unpriced.length)} 筆）：`));
    const list = make('ul', 'blocked-list');
    for (const line of unpriced) list.append(make('li', 'mono', line));
    container.append(list);
  }

  if (status.drift !== null) {
    container.append(driftTable(status));
  } else {
    // 這裡刻意換一張表：沒有漂移報告時畫漂移表（哪怕只是空表）就是「漂移 0」的變體。
    container.append(make('p', 'lfail', '沒有漂移報告 → 不畫漂移表（這不是「漂移 0」）。下面是鏈上實際持倉：'));
    container.append(holdingTable(status));
  }

  const results = make('div');
  const tools = make('div', 'status-tools');
  container.append(tools, results);
  paintTools(opts, status, tools, results);
}

function driftTable(status: api.PortfolioStatus): HTMLElement {
  const table = make('table', 'drift');
  const head = make('thead');
  const headTr = make('tr');
  for (const [text, cls] of [
    ['symbol', ''],
    ['目標 bps', 'num'],
    ['現況 bps', 'num'],
    ['差額', 'num'],
    ['USD 價值', 'num'],
  ] as const) {
    headTr.append(make('th', cls, text));
  }
  head.append(headTr);

  const body = make('tbody');
  for (const row of assetRows(status)) {
    const tr = make('tr');
    const symbol = make('td', 'mono', row.symbol);
    symbol.title = row.asset;
    tr.append(
      symbol,
      make('td', 'num', row.targetBps),
      make('td', 'num', row.currentBps),
      make('td', `num ${row.deltaClass}`, `${row.delta} bps`),
      make('td', 'num', row.usd),
    );
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

function holdingTable(status: api.PortfolioStatus): HTMLElement {
  const table = make('table', 'drift');
  const head = make('thead');
  const headTr = make('tr');
  for (const [text, cls] of [
    ['symbol', ''],
    ['數量', 'num'],
    ['USD 價值', 'num'],
    ['價格來源', ''],
  ] as const) {
    headTr.append(make('th', cls, text));
  }
  head.append(headTr);

  const body = make('tbody');
  for (const row of holdingRows(status)) {
    const tr = make('tr');
    const symbol = make('td', 'mono', row.symbol);
    symbol.title = row.asset;
    tr.append(
      symbol,
      make('td', 'num', row.amount),
      make('td', 'num', row.usd),
      make('td', 'mono', row.priceSource),
    );
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

// ---------------------------------------------------------------- 按鈕 / 確認 / 執行

/** 只有「需要再平衡」且「blocked 是空的」才給觸發按鈕；blocked 非空時任何動作都不該發生。 */
function eligibleForRebalance(status: api.PortfolioStatus): boolean {
  return status.drift !== null && status.drift.needsRebalance && status.blocked.length === 0;
}

/** 重新載入＋（符合條件時）觸發按鈕。`status === null` 代表狀態沒抓到 → 只給重新載入。 */
function paintTools(
  opts: StatusPanelOptions,
  status: api.PortfolioStatus | null,
  tools: HTMLElement,
  results: HTMLElement,
  executedBefore = false,
): void {
  tools.replaceChildren();
  tools.append(makeButton('重新載入狀態', 'ghost', () => void loadStatus(opts)));
  if (status === null) return;
  if (executedBefore) {
    tools.append(make('span', 'hint', '已執行：上面的狀態是執行前的快照，重新載入後再判斷要不要再動。'));
    return;
  }
  if (!eligibleForRebalance(status)) return;
  const trigger = makeButton('觸發再平衡', 'danger', () => paintConfirm(opts, status, tools, results));
  trigger.title = '按下只會展開確認步驟，不會送任何請求；確認後才 POST /portfolios/:id/rebalance';
  tools.append(trigger, make('span', 'hint', '（按下去先看到確認步驟，還不會送出）'));
}

/** 確認步驟：列出事實 → 使用者按「確認執行」才真的 POST。 */
function paintConfirm(
  opts: StatusPanelOptions,
  status: api.PortfolioStatus,
  tools: HTMLElement,
  results: HTMLElement,
): void {
  const box = make('div', 'confirm');
  box.append(
    make('p', '', `將對 portfolio #${String(status.portfolioId)} 執行再平衡：`),
    make('pre', 'confirm-pre', confirmLines(status).join('\n')),
    make('p', 'lfail', '確認後會用 session key 送出鏈上交易，真的動到投組裡的錢。'),
  );

  const row = make('div', 'status-tools');
  const okButton = make('button', 'danger', '確認執行');
  const cancelButton = make('button', 'ghost', '取消');
  okButton.addEventListener('click', () => {
    void executeRebalance(opts, status, { okButton, cancelButton, tools, results });
  });
  cancelButton.addEventListener('click', () => paintTools(opts, status, tools, results));
  row.append(okButton, cancelButton, make('span', 'hint', '（取消不會送任何請求）'));
  box.append(row);
  tools.replaceChildren(box);
}

async function executeRebalance(
  opts: StatusPanelOptions,
  status: api.PortfolioStatus,
  ui: {
    okButton: HTMLButtonElement;
    cancelButton: HTMLButtonElement;
    tools: HTMLElement;
    results: HTMLElement;
  },
): Promise<void> {
  const id = String(opts.portfolioId);
  const token = opts.token();
  if (token === null) {
    ui.results.append(failureBox(['未登入：這支端點需要 Bearer token']));
    return;
  }

  ui.okButton.disabled = true;
  ui.cancelButton.disabled = true;
  ui.okButton.textContent = '送出中…';

  opts.trace.step(`POST /portfolios/${id}/rebalance`);
  try {
    const result = await api.postOperatorRebalance(opts.baseUrl(), token, opts.portfolioId);
    opts.trace.ok(`POST /portfolios/${id}/rebalance → ${result.outcome}`, result);
    opts.trace.raw(`rebalance #${id} 原文`, result);
    renderResult(ui.results, result);
    paintTools(opts, status, ui.tools, ui.results, result.outcome === 'executed');
  } catch (err) {
    opts.trace.fail(`POST /portfolios/${id}/rebalance`, err);
    const failure = rebalanceFailureLines(toErrorLike(err));
    ui.results.append(failure.kind === 'disabled' ? disabledBox(failure.lines) : failureBox(failure.lines));
    paintTools(opts, status, ui.tools, ui.results);
  }
}

// ---------------------------------------------------------------- 結果

function renderResult(host: HTMLElement, result: api.RebalanceResult): void {
  const meta = rebalanceOutcomeMeta(result.outcome);
  const box = make('div', 'result');
  const head = make('div', 'pf-head');
  head.append(
    make('strong', '', `再平衡結果 · portfolio #${String(result.portfolioId)}`),
    badgeSpan(meta.state, meta.label),
    make('span', `outcome-${result.outcome}`, meta.note),
  );
  box.append(head);

  const kv = make('dl', 'kv');
  addKv(kv, 'outcome', `${meta.label} — ${meta.note}`);
  addKv(kv, 'reason', result.reason);
  addKv(kv, 'SwapExecuted', swapExecutedLabel(result.swapExecuted, result.expectedSwaps));
  // 欄位名一起改：後端回的是 UserOp 的 actualGasUsed（含 calldata 的 preVerificationGas），
  // 不是鏈上 tx.gasUsed。標成 gasUsed 會讓人拿去跟區塊瀏覽器比對然後問「為什麼不一樣」。
  addKv(kv, ACTUAL_GAS_USED_FIELD, actualGasUsedLabel(result.gasUsed));
  addKv(kv, 'userOpHash', result.userOpHash ?? '—（沒有 userOpHash）');
  box.append(kv);

  const txRow = make('div', 'tx-row');
  txRow.append(make('span', 'hint', 'txHash'));
  if (result.txHash === null) {
    txRow.append(make('code', 'mono', '—（沒有 tx：這一輪沒有送出任何交易）'));
  } else {
    txRow.append(make('code', 'mono', result.txHash), copyButton(result.txHash));
  }
  box.append(txRow);

  if (result.steps.length > 0) {
    box.append(make('p', 'hint', '這次規劃的 swap step：'));
    box.append(
      make(
        'pre',
        '',
        result.steps
          .map(
            (step, index) =>
              `step ${String(index + 1)}: ${step.tokenIn} → ${step.tokenOut}\n` +
              `         amountIn     ${step.amountIn}\n` +
              `         amountOutMin ${step.amountOutMin}`,
          )
          .join('\n'),
      ),
    );
  } else {
    box.append(
      make(
        'p',
        'hint',
        result.txHash === null ? 'steps: 空（這一輪沒有送出任何 swap）' : 'steps: 後端沒有回 step 明細',
      ),
    );
  }

  if (result.swapExecuted !== null && result.swapExecuted !== result.expectedSwaps) {
    box.append(
      make(
        'p',
        'lfail',
        `⚠ SwapExecuted ${String(result.swapExecuted)} ≠ expectedSwaps ${String(result.expectedSwaps)}：` +
          '實際成交筆數與規劃不符，原因看上面的 reason。',
      ),
    );
  }

  host.append(box);
}
