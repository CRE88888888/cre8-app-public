/**
 * 後端 API 客戶端。形狀照 backend/src/auth.ts + backend/src/server.ts 的實際實作：
 *   POST /auth/nonce  -> 直接回 SiweChallenge（沒有外層 wrapper）
 *   POST /auth/login  -> { message, signature } → { token, expiresAt }
 *   所有錯誤都是 { error: { code, message } }
 * portfolios / renewal 三支則是照 coordinator 釘死的契約（後端目前尚未實作）。
 */
export type SiweChallenge = {
  nonce: string;
  domain: string;
  chainId: number;
  uri: string;
  statement: string;
  version: string;
  issuedAt: string;
  expiresAt: string;
};

export type SessionCredentials = { token: string; expiresAt: string };

export type SmartAccountRef = {
  chainId: number;
  address: string;
  owner: string;
  accountType: string;
};

export type GasState = {
  ready?: boolean;
  balanceWei?: string;
  minGasWei?: string;
  [k: string]: unknown;
};

export type SessionKeyState = {
  permissionId: string;
  sessionKeyAddress: string;
  keyRef: string;
  expiresAt: string | number;
  status: string;
};

export type Portfolio = {
  id: number | string;
  strategyId: number | string;
  version: number | string;
  scheduleState: string;
  createdAt: string;
  smartAccounts: SmartAccountRef[];
  gas: GasState | null;
  sessionKey: SessionKeyState | null;
};

export type RenewalParams = {
  portfolioId: number | string;
  strategyId: number | string;
  chainId: number;
  ownerAddress: string;
  accountAddress: string;
  executorAddress: string;
  entryPoint: string;
  kernelVersion: string;
  sessionKeyAddress: string;
  keyRef: string;
  validUntil: string | number;
  expiresAt: string | number;
  permissionId: string;
  policySnapshot: unknown;
  initConfig: string[];
  bundlerUrl: string;
};

export type RenewalResultBody = {
  txHash: string;
  userOpHash: string;
  permissionId: string;
  sessionKeyAddress: string;
  keyRef: string;
  validUntil: string | number;
  policySnapshot: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly raw?: string;

  constructor(message: string, status: number, code?: string, raw?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

/** 後端 { error: { code, message } }；保留 raw body，因為驗證流程時原文就是線索。 */
function describeFailure(status: number, raw: string): ApiError {
  let code: string | undefined;
  let message = raw === '' ? `HTTP ${status}` : raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } };
    if (parsed?.error) {
      code = parsed.error.code;
      message = parsed.error.message ?? message;
    }
  } catch {
    // 非 JSON（例如 proxy 的 502 HTML）— 原文照樣往上丟。
  }
  return new ApiError(message, status, code, raw);
}

async function call<T>(base: string, path: string, init: RequestInit, token?: string): Promise<T> {
  const url = `${base}${path}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err) {
    // fetch 只在「連不上」時 throw；連 CORS 被擋都會走這裡。這就是為什麼預設要開 proxy。
    throw new ApiError(
      `連不上 ${url}（${(err as Error).message}）。若後端有開，多半是被 CORS 擋掉或 proxy 沒開。`,
      0,
      'NETWORK',
    );
  }

  const raw = await res.text();
  if (!res.ok) throw describeFailure(res.status, raw);
  if (raw === '') return undefined as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(`回應不是 JSON（HTTP ${res.status}）`, res.status, 'BAD_JSON', raw);
  }
}

export function requestNonce(base: string): Promise<SiweChallenge> {
  return call<SiweChallenge>(base, '/auth/nonce', { method: 'POST', body: '{}' });
}

export function requestLogin(base: string, message: string, signature: string): Promise<SessionCredentials> {
  return call<SessionCredentials>(base, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ message, signature }),
  });
}

export async function listPortfolios(base: string, token: string): Promise<Portfolio[]> {
  const body = await call<{ portfolios?: Portfolio[] }>(base, '/portfolios', { method: 'GET' }, token);
  // 容錯：後端若直接回陣列也吃。
  const list = Array.isArray(body) ? (body as unknown as Portfolio[]) : body?.portfolios;
  if (!Array.isArray(list)) throw new ApiError('GET /portfolios 回應沒有 portfolios 陣列', 200, 'BAD_SHAPE', JSON.stringify(body));
  return list;
}

export function getRenewalParams(base: string, token: string, id: number | string): Promise<RenewalParams> {
  return call<RenewalParams>(base, `/portfolios/${id}/renewal-params`, { method: 'GET' }, token);
}

export function postRenewalResult(
  base: string,
  token: string,
  id: number | string,
  body: RenewalResultBody,
): Promise<{ ok: boolean; recorded?: unknown; duplicate?: true }> {
  return call(base, `/portfolios/${id}/renewal-result`, { method: 'POST', body: JSON.stringify(body) }, token);
}

// ---------------------------------------------------------------------------
// 投組狀態 / operator rebalance
// 形狀照 backend/src/operator.ts 的實際實作（不是猜的）：
//   GET  /portfolios/:id/status   → PortfolioStatus（算不出來時 503 STATUS_UNAVAILABLE）
//   POST /portfolios/:id/rebalance → RebalanceResult（沒開 ENABLE_OPERATOR_REBALANCE 時 403）
// ⚠ 所有 bigint 都以十進位字串傳（JSON 沒有 bigint），單位是 1e8 定點 USD。
// ---------------------------------------------------------------------------

export type StatusHolding = {
  asset: string;
  symbol: string;
  amountWei: string;
  decimals: number;
  usdValueE8: string;
  priceSource: string;
};

/** 沒有可用價格的資產：它會讓漂移拒算（blocked），所以必須看得到。 */
export type StatusUnpriced = {
  asset: string;
  symbol: string;
  amountWei: string;
  decimals: number;
  reason: string;
};

export type StatusTarget = { asset: string; symbol: string; weightBps: number };

export type StatusDriftAsset = {
  asset: string;
  symbol: string;
  targetBps: number;
  currentBps: number;
  deltaBps: number;
  usdValueE8: string;
};

export type StatusDrift = {
  grossDriftBps: number;
  maxAbsDeltaBps: number;
  needsRebalance: boolean;
  thresholdBps: number;
  assets: StatusDriftAsset[];
};

export type StatusSessionKeyRef = { permissionId: string; keyRef: string };

/**
 * `GET /portfolios/:id/status` 的 sessionKey 欄位：DB 記的 key 與**實際會用**的那把。
 *
 * `error` 非 null ＝這次讀不到（DB/鏈）。那時 `usable: null` 不可以被讀成「沒有任何可用的 key」。
 */
export type StatusSessionKey = {
  configured: (StatusSessionKeyRef & { installed: boolean }) | null;
  usable: StatusSessionKeyRef | null;
  error: string | null;
};

export type PortfolioStatus = {
  portfolioId: number;
  /** 這次觀測釘住的塊高（十進位字串）。 */
  block: string;
  account: string;
  holdings: StatusHolding[];
  unpriced: StatusUnpriced[];
  /** 沒有漂移報告時是 null —— 不是 0。 */
  totalUsdE8: string | null;
  targets: StatusTarget[];
  drift: StatusDrift | null;
  blocked: { code: string; detail: string }[];
  /** false ≠ 請求失敗：只是這個投組現在算不出完整狀態。真正的失敗是 503。 */
  complete: boolean;
  /** 舊版後端沒有這個欄位，所以是 optional：undefined ≠「沒有可用的 key」。 */
  sessionKey?: StatusSessionKey | null;
};

export type RebalanceOutcome = 'executed' | 'noop' | 'blocked' | 'reverted' | 'failed';

export type RebalanceStep = { tokenIn: string; tokenOut: string; amountIn: string; amountOutMin: string };

export type RebalanceResult = {
  portfolioId: number;
  outcome: RebalanceOutcome;
  /** 排程器寫的那句話（含哪一層沒過、為什麼 blocked），原文。 */
  reason: string;
  txHash: string | null;
  userOpHash: string | null;
  /** receipt 裡 executor 發出的 SwapExecuted 筆數；null = 有 tx 但讀不到 receipt。 */
  swapExecuted: number | null;
  expectedSwaps: number;
  gasUsed: string | null;
  /** blocked / noop 時是空的。 */
  steps: RebalanceStep[];
};

export function getPortfolioStatus(base: string, token: string, id: number | string): Promise<PortfolioStatus> {
  return call<PortfolioStatus>(base, `/portfolios/${id}/status`, { method: 'GET' }, token);
}

/**
 * ⚠ 唯一一支會動錢的端點：後端用 session key 送出鏈上交易。
 * 沒開 ENABLE_OPERATOR_REBALANCE=true 時後端回 403 `OPERATOR_REBALANCE_DISABLED`（預設就是關的）。
 * body 送 `{}`：後端不讀它，但與其他 POST 維持同一個形狀。
 */
export function postOperatorRebalance(
  base: string,
  token: string,
  id: number | string,
): Promise<RebalanceResult> {
  return call<RebalanceResult>(base, `/portfolios/${id}/rebalance`, { method: 'POST', body: '{}' }, token);
}
