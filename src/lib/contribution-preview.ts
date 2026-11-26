/**
 * 入金期數預覽（backend#123，`POST /strategies/preview-contribution`）：這筆投入每個 stack 資產實際分幾期。
 *
 * 後端算的期數為準；請求失敗（限流、逾時、網路）才退回 `stackPlan` 的簡化估計，畫面標「about」。
 * 422 是金額本身的問題（低於最低投入、超過預覽上限、湊不成一整批），不估計，直接說明。
 * 只有 chain 97 呼叫（後端目前只收 chain 97 schema 2）；其他鏈一律用估計。
 * 輸入要 debounce（400ms），同時只留最後一個請求，避免撞 429。純邏輯：不碰 React。
 */
import { ApiError, postPreviewContribution, type ContributionPreview, type ContributionPreviewBody } from './api';
import { STACK_MIN_BUY_USDT, minimumDepositFor, stackBuys, typedVersionBody, type AssetExecution, type StackBuy } from './fund-execution';

export const PREVIEW_CHAIN_ID = 97;
export const PREVIEW_DEBOUNCE_MS = 400;
const UNIT = 10n ** 18n;

/** 422 的三種：金額本身不行，畫面說原因、不估計。 */
export type PreviewBlock = 'BELOW_MINIMUM_ALLOCATION' | 'PREVIEW_AMOUNT_TOO_LARGE' | 'BELOW_MIN_BATCH';
const BLOCKS: readonly string[] = ['BELOW_MINIMUM_ALLOCATION', 'PREVIEW_AMOUNT_TOO_LARGE', 'BELOW_MIN_BATCH'];

export type PreviewState =
  /** 沒有要預覽的（不是 chain 97、沒有 stack、金額是 0）。 */
  | { status: 'idle' }
  /** 等 debounce 或回應中：先顯示估計。 */
  | { status: 'loading' }
  | { status: 'ok'; amountRaw: string; preview: ContributionPreview }
  | { status: 'blocked'; code: PreviewBlock }
  /** 其他失敗（429、503、400、網路、回應形狀不對）：退回估計。 */
  | { status: 'fallback'; code: string };

/** 422 的說明（買家頁）。 */
export const PREVIEW_BLOCK_COPY: Record<PreviewBlock, string> = {
  BELOW_MINIMUM_ALLOCATION: 'This amount is below the minimum deposit for this fund.',
  PREVIEW_AMOUNT_TOO_LARGE: 'The buy plan can be previewed for up to 10,000,000 USDT.',
  BELOW_MIN_BATCH: `This amount can't make a full ${STACK_MIN_BUY_USDT} USDT buy, so it can't be split into buys.`,
};

/** 只收 18 decimals 的十進位整數字串。 */
const isRaw = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);

/** 請求裡每個 stack 資產（小寫地址）創作者設的期數。 */
/**
 * 依完整請求建每個非現金資產可接受的期數上限（審查 #95 第二輪 #13）：後端的 `effectiveSlices` 列出全部非現金資產，
 * Hold 一律是 1，Stack 是 1 到創作者設的期數。另回非現金權重（bps），算前端公式的最低投入用。
 */
function requestShape(execution: unknown): { allowed: Map<string, number>; investedBps: number[] } {
  const allowed = new Map<string, number>();
  const investedBps: number[] = [];
  const { assets, numeraire } = (execution ?? {}) as { assets?: unknown; numeraire?: unknown };
  if (!Array.isArray(assets)) return { allowed, investedBps };
  const cash = typeof numeraire === 'string' ? numeraire.toLowerCase() : null;
  for (const entry of assets as { asset?: unknown; weightBps?: unknown; execution?: { kind?: unknown; slices?: unknown } }[]) {
    if (typeof entry?.asset !== 'string' || entry.asset.toLowerCase() === cash) continue;
    if (typeof entry.weightBps === 'number') investedBps.push(entry.weightBps);
    const mode = entry.execution;
    allowed.set(entry.asset.toLowerCase(), mode?.kind === 'stack' && typeof mode.slices === 'number' ? mode.slices : 1);
  }
  return { allowed, investedBps };
}

/** 每期時間可以比這台裝置的現在早多少（時鐘誤差）：超過就當回應不對。 */
const SLOT_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * 回應形狀不對、或對不上這次的請求，就當失敗（退回估計、標 about），不把怪資料顯示成準確數字（審查 #95 第 7、13 項）：
 * - 最低投入不能低於前端公式（`minimumDepositFor`，與後端 `minimumAssetContribution` 同算法）；
 * - 期數只能是這次請求裡的非現金資產：Hold 只能是 1，Stack 是 1 到創作者設的期數；
 * - 每期時間要是有效日期、在現在之後（容許 5 分鐘時鐘誤差）、一期比一期晚；每期預算大於 0。
 * 沒給 `request`（舊呼叫）只檢查形狀。
 */
export function parsePreview(body: unknown, request?: ContributionPreviewBody, now: number = Date.now()): ContributionPreview | null {
  if (typeof body !== 'object' || body === null) return null;
  const { minimumRaw, effectiveSlices, slots } = body as Record<string, unknown>;
  if (!isRaw(minimumRaw) || BigInt(minimumRaw) === 0n || typeof effectiveSlices !== 'object' || effectiveSlices === null || !Array.isArray(slots)) return null;
  const shape = request === undefined ? null : requestShape(request.execution);
  if (shape !== null && BigInt(minimumRaw) < BigInt(minimumDepositFor(shape.investedBps)) * UNIT) return null;
  const slices: Record<string, number> = {};
  for (const [asset, count] of Object.entries(effectiveSlices)) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
    const key = asset.toLowerCase();
    if (shape !== null) {
      const max = shape.allowed.get(key);
      if (max === undefined || count > max) return null;
    }
    slices[key] = count;
  }
  const parsedSlots: ContributionPreview['slots'] = [];
  let previous = -Infinity;
  for (const slot of slots) {
    const item = slot as { at?: unknown; budgetRaw?: unknown } | null;
    if (typeof item?.at !== 'string' || !isRaw(item.budgetRaw) || BigInt(item.budgetRaw) === 0n) return null;
    const at = Date.parse(item.at);
    if (!Number.isFinite(at) || at <= previous || (shape !== null && at < now - SLOT_CLOCK_SKEW_MS)) return null;
    previous = at;
    parsedSlots.push({ at: item.at, budgetRaw: item.budgetRaw });
  }
  return { minimumRaw, effectiveSlices: slices, slots: parsedSlots };
}

/** 錯誤分成「金額不行」（422 三種）與「退回估計」（其他全部）。 */
export function previewFailure(cause: unknown): PreviewState {
  if (cause instanceof ApiError && cause.status === 422 && BLOCKS.includes(cause.code)) return { status: 'blocked', code: cause.code as PreviewBlock };
  return { status: 'fallback', code: cause instanceof ApiError ? cause.code : 'NETWORK' };
}

/**
 * USDT 的十進位字串（使用者輸入的原字、或整數金額）換成 raw；全程字串／BigInt，不經 Number（審查 #95 第 10 項：
 * 59.9999999 不能變成 60）。千分位逗號去掉；0、負數、超過 18 位小數、格式不對回 null。
 */
export function usdtToRaw(value: string): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim().replace(/,/g, ''));
  if (match === null || (match[2] ?? '').length > 18) return null;
  const raw = BigInt(match[1] as string) * UNIT + BigInt(((match[2] ?? '') + '0'.repeat(18)).slice(0, 18) || '0');
  return raw > 0n ? raw.toString() : null;
}

export const rawToUsdt = (raw: string): number => Number(BigInt(raw) / 10n ** 12n) / 1e6;

/** 執行設定裡有沒有 stack 資產（沒有就不必預覽）。 */
export function hasStack(execution: unknown): boolean {
  const assets = (execution as { kind?: unknown; assets?: unknown } | null)?.kind === 'per_asset' ? (execution as { assets?: unknown }).assets : null;
  return Array.isArray(assets) && assets.some((entry) => (entry as { execution?: { kind?: unknown } } | null)?.execution?.kind === 'stack');
}

/** 要不要（能不能）預覽：chain 97、per_asset 有 stack、金額大於 0。不行回 null（呼叫端用估計）。 */
export function previewBody(chainId: number, execution: unknown, amountRaw: string | null): ContributionPreviewBody | null {
  if (chainId !== PREVIEW_CHAIN_ID || amountRaw === null || !hasStack(execution)) return null;
  return { chainId, execution: execution as Record<string, unknown>, amountRaw };
}

/**
 * 每個 stack 資產分幾期：預覽成功用後端的期數（`about: false`），每期金額＝該資產預算 floor(總額×bps/10000) ÷ 期數；
 * 其他狀態用簡化估計（`about: true`）。後端沒列到的資產也退回估計。
 */
export function previewBuys(execution: unknown, deposit: number, state: PreviewState): StackBuy[] {
  const estimate = stackBuys(execution, deposit);
  if (state.status !== 'ok') return estimate;
  const amount = BigInt(state.amountRaw);
  const weights = new Map<string, number>();
  for (const entry of ((execution as { assets?: unknown[] }).assets ?? []) as { asset?: string; weightBps?: number }[]) {
    if (typeof entry?.asset === 'string' && typeof entry.weightBps === 'number') weights.set(entry.asset.toLowerCase(), entry.weightBps);
  }
  return estimate.map((buy) => {
    const count = state.preview.effectiveSlices[buy.asset.toLowerCase()];
    const bps = weights.get(buy.asset.toLowerCase());
    if (count === undefined || bps === undefined) return buy;
    const budget = (amount * BigInt(bps)) / 10_000n;
    return { ...buy, buys: count, perBuy: rawToUsdt(budget.toString()) / count, about: false };
  });
}

/**
 * 設計器用最低投入當金額問，最低投入以後端為準：`minimum` 是要顯示的最低投入；後端的跟這次送的金額不同時，
 * `retryRaw` 是要用來再問一次的金額，期數要等那一次（`settled`）才算數，之前先用估計。
 */
export function backendMinimum(state: PreviewState, fallback: number): { minimum: number; retryRaw: string | null; settled: boolean } {
  if (state.status !== 'ok') return { minimum: fallback, retryRaw: null, settled: false };
  const settled = state.preview.minimumRaw === state.amountRaw;
  return { minimum: rawToUsdt(state.preview.minimumRaw), retryRaw: settled ? null : state.preview.minimumRaw, settled };
}

/**
 * 設計器的預覽本文：用列的權重與 stack 設定組出跟發布時一樣的 execution（含完整 cash 項），生息一律 null（不影響期數）。
 * 有列換不出設定、資產沒有測試網地址、權重超過 100% 時回 null（用估計）。
 */
export function designPreviewExecution(
  rows: readonly { key: string; share: number }[],
  assets: ReadonlyMap<string, AssetExecution>,
  tokenOf: (key: string) => string | null,
  usdt: string,
): ContributionPreviewBody['execution'] | null {
  const weights = new Map<string, number>();
  for (const row of rows) weights.set(row.key, (weights.get(row.key) ?? 0) + Math.round(row.share * 100));
  const invested: { address: string; weightBps: number; execution: AssetExecution }[] = [];
  for (const [key, weightBps] of weights) {
    if (weightBps <= 0) continue;
    const address = tokenOf(key);
    const execution = assets.get(key);
    if (address === null || execution === undefined) return null;
    invested.push({ address, weightBps, execution });
  }
  const cash = 10_000 - invested.reduce((sum, asset) => sum + asset.weightBps, 0);
  if (cash < 0) return null;
  try {
    return typedVersionBody({ chainId: PREVIEW_CHAIN_ID, usdt, assets: [...invested, { address: usdt, weightBps: cash }] }).execution;
  } catch {
    return null;
  }
}

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * debounce＋只留最後一個：每次 `request` 先取消還沒送的計時、abort 上一個請求；舊請求晚回來也不覆蓋新狀態。
 * `request(null)` 回到 idle。
 */
export function previewScheduler(
  onState: (state: PreviewState) => void,
  options: { delayMs?: number; send?: (body: ContributionPreviewBody, signal: AbortSignal) => Promise<unknown>; timers?: Timers; now?: () => number } = {},
) {
  const { delayMs = PREVIEW_DEBOUNCE_MS, send = postPreviewContribution, timers = realTimers, now = Date.now } = options;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let seq = 0;
  const stop = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };
  return {
    request(body: ContributionPreviewBody | null): void {
      stop();
      const mine = ++seq;
      if (body === null) return onState({ status: 'idle' });
      onState({ status: 'loading' });
      timer = timers.set(() => {
        timer = null;
        const own = new AbortController();
        controller = own;
        send(body, own.signal).then(
          (response) => {
            if (mine !== seq) return;
            const preview = parsePreview(response, body, now());
            onState(preview === null ? { status: 'fallback', code: 'BAD_RESPONSE' } : { status: 'ok', amountRaw: body.amountRaw, preview });
          },
          (cause: unknown) => {
            if (mine === seq) onState(previewFailure(cause));
          },
        );
      }, delayMs);
    },
    cancel(): void {
      seq++;
      stop();
    },
  };
}
