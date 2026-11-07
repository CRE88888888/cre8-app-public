/**
 * 投組狀態 / 再平衡結果的「純格式化」層：沒有 DOM、沒有 fetch、沒有任何會在 import 時跑起來的模組。
 *
 * 為什麼要單獨一層：這個面板最危險的錯誤都是「文字寫錯」，不是邏輯寫錯 ——
 *   * 讀不到狀態（503）被畫成「漂移 0 / 不需要再平衡」，使用者會以為投組很好；
 *   * `drift === null`（後端沒有漂移報告）被畫成「漂移 0」。
 * 切出來之後可以用 `bun -e 'import(...)'` 直接餵真實 payload 驗算：不開瀏覽器、不按任何按鈕，
 * 也就完全不可能送出鏈上交易。UI 只負責把這裡產出的字串貼上去。
 */
import type { PortfolioStatus, RebalanceOutcome } from './api.js';

const E8 = 100_000_000n;

/** 1e8 定點的 USD 字串 → `$511,338.07`。小數**截斷**（不四捨五入），與後端整數除法的習慣一致。 */
export function formatUsdE8(raw: string | null): string {
  if (raw === null) return '—';
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    // 契約是十進位整數字串。真的不是就原樣印出來，不編一個看起來合理的數字。
    return `${raw}（不是十進位整數字串，原樣顯示）`;
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / E8).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = ((abs % E8) / 1_000_000n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${whole}.${cents}`;
}

/** 原始最小單位數量 → 人類可讀（小數保留 6 位、去掉尾零）。 */
export function formatTokenAmount(amountWei: string, decimals: number): string {
  let value: bigint;
  try {
    value = BigInt(amountWei);
  } catch {
    return amountWei;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return amountWei;
  if (decimals === 0) return value.toString();
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const frac = (value % unit)
    .toString()
    .padStart(decimals, '0')
    .slice(0, 6)
    .replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole.toString()}.${frac}`;
}

/** bps 差額帶正負號：`+1521` / `-820` / `0`。 */
export function signedBps(bps: number): string {
  if (bps > 0) return `+${String(bps)}`;
  if (bps < 0) return String(bps);
  return '0';
}

export type DriftTone = 'hot' | 'cool' | 'unknown';

/**
 * 漂移那一行（面板上最醒目的一行）。
 *
 * `drift === null` 時回的是一句「沒有漂移報告」，**不是** `0 bps / 不需要再平衡` ——
 * 那是這個面板最容易也最嚴重的一種誤導。
 */
export function driftLine(status: PortfolioStatus): { text: string; tone: DriftTone } {
  if (status.drift === null) {
    return {
      tone: 'unknown',
      text: '漂移：後端這次沒有回漂移報告（drift = null）—— 這不等於「漂移 0、不需要再平衡」；原因見下面的 blocked',
    };
  }
  const drift = status.drift;
  return {
    tone: drift.needsRebalance ? 'hot' : 'cool',
    text:
      `gross drift ${String(drift.grossDriftBps)} bps ／ 門檻 ${String(drift.thresholdBps)} bps ／ ` +
      `需要再平衡：${drift.needsRebalance ? '是' : '否'}（最大單一資產差 ${String(drift.maxAbsDeltaBps)} bps）`,
  };
}

/** `complete === false` 的明確標示；完整時回 null（不畫任何東西）。 */
export function completenessWarning(status: PortfolioStatus): string | null {
  if (status.complete) return null;
  const codes = status.blocked.map((block) => block.code);
  if (status.drift === null) {
    const suffix = codes.length > 0 ? `（blocked: ${codes.join('、')}）` : '';
    return `這份狀態不完整（complete = false）：後端沒有回漂移報告${suffix}。這不是「漂移 0」。`;
  }
  const suffix =
    codes.length > 0
      ? `：blocked = ${codes.join('、')}`
      : '（blocked 是空的，但後端仍標記為不完整）';
  return `這份漂移不完整（complete = false）${suffix}。下面的數字只覆蓋它算得出來的部分。`;
}

/** blocked 逐條：`CODE: detail`（detail 是後端原文，不改寫）。 */
export function blockedLines(status: PortfolioStatus): string[] {
  return status.blocked.map((block) => `${block.code}: ${block.detail}`);
}

/** 沒有價格的資產；它們通常就是 blocked 的原因，所以要單獨看得到。 */
export function unpricedLines(status: PortfolioStatus): string[] {
  return status.unpriced.map(
    (asset) =>
      `${asset.symbol}  數量 ${formatTokenAmount(asset.amountWei, asset.decimals)}  — 沒有價格：${asset.reason}`,
  );
}

export type AssetRow = {
  symbol: string;
  asset: string;
  targetBps: string;
  currentBps: string;
  delta: string;
  deltaClass: 'pos' | 'neg' | 'zero';
  usd: string;
};

/** 漂移表的一列。`drift === null` 時回空陣列（呼叫端必須改畫持倉表，不能畫成空漂移表）。 */
export function assetRows(status: PortfolioStatus): AssetRow[] {
  const assets = status.drift?.assets ?? [];
  return assets.map((asset) => ({
    symbol: asset.symbol,
    asset: asset.asset,
    targetBps: String(asset.targetBps),
    currentBps: String(asset.currentBps),
    delta: signedBps(asset.deltaBps),
    deltaClass: asset.deltaBps > 0 ? 'pos' : asset.deltaBps < 0 ? 'neg' : 'zero',
    usd: formatUsdE8(asset.usdValueE8),
  }));
}

export type HoldingRow = { symbol: string; asset: string; amount: string; usd: string; priceSource: string };

/** 持倉表：沒有漂移報告時，至少讓使用者看到「鏈上實際有什麼」。 */
export function holdingRows(status: PortfolioStatus): HoldingRow[] {
  return status.holdings.map((holding) => ({
    symbol: holding.symbol,
    asset: holding.asset,
    amount: formatTokenAmount(holding.amountWei, holding.decimals),
    usd: formatUsdE8(holding.usdValueE8),
    priceSource: holding.priceSource,
  }));
}

/**
 * 確認步驟要顯示的內容（純文字）。
 *
 * `GET /portfolios/:id/status` 的回應裡**沒有** swap step 明細（只有 `POST .../rebalance` 的結果才有
 * `steps`），所以這裡只能列「漂移 + 每個資產的 目標→現況/差額/USD」，並明講參數由後端規劃。
 * 不要為了讓確認畫面看起來完整而編出方向與數量 —— 那正是使用者會拿來判斷「要不要按下去」的東西。
 */
export function confirmLines(status: PortfolioStatus): string[] {
  const lines: string[] = [
    `portfolio #${String(status.portfolioId)}    狀態觀測於 block #${status.block}`,
    `account ${status.account}`,
  ];
  const drift = status.drift;
  if (drift !== null) {
    lines.push(
      `漂移 ${String(drift.grossDriftBps)} bps ／ 門檻 ${String(drift.thresholdBps)} bps（需要再平衡：是）`,
      `總價值 ${formatUsdE8(status.totalUsdE8)}`,
    );
    if (drift.assets.length > 0) {
      lines.push('', '資產（目標 bps → 現況 bps，差額，USD 價值）：');
      for (const asset of assetRows(status)) {
        lines.push(
          `  ${asset.symbol.padEnd(10)} ${asset.targetBps.padStart(5)} → ${asset.currentBps.padStart(5)}` +
            `  ${asset.delta.padStart(6)} bps  ${asset.usd}`,
        );
      }
    }
  }
  lines.push(
    '',
    'status 回應裡沒有 swap step 明細：實際的 swap 參數（tokenIn/tokenOut、amountIn、amountOutMin）由後端',
    'planPortfolio 規劃；執行後才會在結果裡看到它們。',
  );
  return lines;
}

/** `SwapExecuted n/m`；讀不到 receipt 時不寫成 0（0 會被讀成「數過，真的 0 筆」）。 */
export function swapExecutedLabel(swapExecuted: number | null, expectedSwaps: number): string {
  if (swapExecuted === null) return `SwapExecuted ?/${String(expectedSwaps)}（有 tx，但讀不到 receipt）`;
  return `SwapExecuted ${String(swapExecuted)}/${String(expectedSwaps)}`;
}

export type OutcomeMeta = { label: string; state: 'ok' | 'run' | 'fail' | 'idle'; note: string };

/**
 * 結果卡上那個 gas 欄位的**真名**。
 *
 * 後端回的 `gasUsed` 不是區塊瀏覽器上的 `tx.gasUsed`：它取自 `UserOperationEvent.actualGasUsed`，
 * **包含 `preVerificationGas`**（calldata 的固定費率成本，不是真的 EVM gas）。實測同一筆交易：
 * 這裡 857,487、鏈上 `tx.gasUsed` 694,521，差額 162,966 ≈ calldata 成本。
 * 標成 `gasUsed` 會讓人拿去跟瀏覽器比對，然後問「為什麼不一樣」——所以欄位名本身就是說明的一部分。
 */
export const ACTUAL_GAS_USED_FIELD = 'actualGasUsed';

/** 那個欄位的值＋說明。null 只代表「這一輪沒有送出交易」，不是「0 gas」。 */
export function actualGasUsedLabel(raw: string | null): string {
  if (raw === null || raw === '') return '—（這一輪沒有送到鏈上，所以沒有 gas）';
  return `${raw}（帳戶被扣的 gas，含 calldata 的 preVerificationGas；不是鏈上 tx.gasUsed，兩者不該相等）`;
}

/** 沿用漂移那一行的三種 tone（`index.html` 只定義了 hot / cool / unknown 這三個 class）。 */
export type SessionKeyLine = { tone: DriftTone; text: string };

/**
 * session key 那一行：**DB 記的 key** 與**實際會用的 key** 是兩件事。
 *
 * 實測 portfolio 5 的 DB key 在鏈上 `permissionConfig(...).signer` 是零地址（＝沒安裝），排程器會
 * 自動退回舊的那把。只顯示 DB 那一把，等於顯示一個不會被使用的 key。
 *
 * `error` 與「舊後端沒有這個欄位」都要講成「讀不到」，**不可以**畫成「沒有可用的 key」——
 * 那是這個面板最容易犯的誤導。
 */
export function sessionKeyLines(status: PortfolioStatus): SessionKeyLine[] {
  const sk = status.sessionKey;
  if (sk === undefined || sk === null) {
    return [
      { tone: 'unknown', text: 'session key：後端沒有回這個欄位（舊版後端？）—— 這不等於「沒有可用的 key」' },
    ];
  }
  if (sk.error !== null) {
    return [
      { tone: 'unknown', text: `session key：讀不到安裝狀態（${sk.error}）—— 這不等於「沒有可用的 key」` },
    ];
  }
  const configured = sk.configured;
  if (configured === null) {
    return [{ tone: 'hot', text: '⚠ 沒有任何可用的 session key（DB 沒有記過任何 active key）：再平衡會被擋' }];
  }
  if (configured.installed) {
    return [{ tone: 'cool', text: `session key ${configured.permissionId}（已安裝）　${configured.keyRef}` }];
  }
  if (sk.usable !== null) {
    return [
      {
        tone: 'hot',
        text:
          `⚠ DB 記的 key ${configured.permissionId} 鏈上沒安裝；` +
          `實際會用 ${sk.usable.permissionId}（${sk.usable.keyRef}）`,
      },
    ];
  }
  return [
    {
      tone: 'hot',
      text:
        `⚠ DB 記的 key ${configured.permissionId} 鏈上沒安裝，而且沒有任何已安裝的 active key` +
        ` → 再平衡會被擋（不是「剛好在等時機」）`,
    },
  ];
}

/** 五種 outcome 的顏色與一句話後果。`reverted` 與 `failed` 不能同色同話：一個花了 gas，一個沒送出去。 */
export function rebalanceOutcomeMeta(outcome: RebalanceOutcome): OutcomeMeta {
  switch (outcome) {
    case 'executed':
      return { label: 'executed', state: 'ok', note: '已上鏈執行' };
    case 'noop':
      return { label: 'noop', state: 'idle', note: '算過但沒有需要動的：沒有送出交易' };
    case 'blocked':
      return { label: 'blocked', state: 'run', note: '被擋下：沒有送出交易' };
    case 'reverted':
      return { label: 'reverted', state: 'fail', note: '上鏈了但失敗：gas 已經花了' };
    case 'failed':
      return { label: 'failed', state: 'fail', note: '沒有送出去（或送出失敗）：沒有上鏈證據' };
  }
}

/** 給純函式用的錯誤形狀（結構上相容於 `ApiError`，但不需要在這一層 import 它）。 */
export type ErrorLike = {
  name?: string;
  message: string;
  status?: number;
  code?: string;
  raw?: string;
};

/**
 * `GET /portfolios/:id/status` 失敗時要顯示的內容：**只有原文**，一個漂移數字都不給。
 * 503 是「讀不到」（RPC 掛 / fork 過期 / DB 不一致），必須講清楚它不是「狀態很好」。
 */
export function statusFailureLines(err: ErrorLike): string[] {
  const status = err.status ?? 0;
  const codeSuffix = err.code === undefined ? '' : ` / code=${err.code}`;
  const head =
    status === 503
      ? `算不出狀態（HTTP 503${codeSuffix}）：這是「讀不到狀態」，不是「漂移 0、不需要再平衡」`
      : status > 0
        ? `狀態請求失敗（HTTP ${String(status)}${codeSuffix}）`
        : '狀態請求失敗（連不上後端，或請求被擋）';
  const lines = [head, `後端訊息原文：${err.message}`];
  if (err.raw !== undefined && err.raw !== '') lines.push(`raw body: ${err.raw}`);
  lines.push('因為沒有可信的狀態，這裡刻意不顯示任何漂移 / 總價值數字。');
  return lines;
}

export type RebalanceFailure = { kind: 'disabled' | 'not-owner' | 'other'; lines: string[] };

/**
 * `POST /portfolios/:id/rebalance` 失敗時的分類。
 *
 * `403 OPERATOR_REBALANCE_DISABLED` 是部署層的開關（後端預設關閉），不是一般錯誤：
 * 它要在畫面上長得不一樣，而且要保留後端原文 —— 使用者要拿那句話去改環境變數。
 */
export function rebalanceFailureLines(err: ErrorLike): RebalanceFailure {
  const status = err.status ?? 0;
  const code = err.code ?? '';
  const raw = err.raw ?? '';
  const withRaw = (lines: string[]): string[] =>
    raw === '' ? lines : [...lines, `raw body: ${raw}`];

  if (code === 'OPERATOR_REBALANCE_DISABLED' || (status === 403 && raw.includes('OPERATOR_REBALANCE_DISABLED'))) {
    return {
      kind: 'disabled',
      lines: withRaw([
        '後端未啟用 operator rebalance（需要 ENABLE_OPERATOR_REBALANCE=true）。這支端點會用 session key 送出鏈上交易、真的動到投組裡的錢，所以預設是關的。',
        `後端訊息原文：${err.message}`,
      ]),
    };
  }
  if (status === 403 || status === 404) {
    return {
      kind: 'not-owner',
      lines: withRaw([
        `後端拒絕（HTTP ${String(status)}${code === '' ? '' : ` / ${code}`}）：多半是這個 portfolio 不屬於你目前登入的錢包，或它不存在。`,
        `後端訊息原文：${err.message}`,
      ]),
    };
  }
  return {
    kind: 'other',
    lines: withRaw([
      status > 0 ? `再平衡請求失敗（HTTP ${String(status)}${code === '' ? '' : ` / ${code}`}）` : '再平衡請求失敗（連不上後端）',
      `後端訊息原文：${err.message}`,
    ]),
  };
}
