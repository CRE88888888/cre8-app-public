/**
 * 後端 API 客戶端。形狀照 `backend/src/server.ts` 的實際實作：
 *   POST /auth/nonce  -> SiweChallenge（無外層 wrapper）
 *   POST /auth/login  -> { message, signature } → { token, expiresAt }
 *   GET  /portfolios  -> Portfolio[]（**直接是陣列**，不是 { portfolios: [...] }）
 *   所有錯誤都是 { error: { code, message } }
 *
 * 一律走相對路徑 `/api`（dev 由 vite proxy 轉到 127.0.0.1:8081）。同源就沒有 CORS 與 preflight。
 */

const BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

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
  address?: string;
  balanceWei?: string;
  minimumWei?: string;
  ready?: boolean;
  shortfallWei?: string;
  estimatedOps?: number;
} | null;

export type SessionKeyState = {
  permissionId: string;
  sessionKeyAddress: string;
  keyRef: string;
  expiresAt: string;
  status: string;
} | null;

export type Portfolio = {
  id: number;
  userId: string;
  strategyId: number;
  version: number;
  scheduleState: string;
  createdAt: string;
  smartAccounts: SmartAccountRef[];
  gas: GasState;
  sessionKey: SessionKeyState;
};

export type DriftAssetRow = {
  asset: string;
  symbol: string;
  targetBps: number;
  currentBps: number;
  deltaBps: number;
  usdValueE8: string;
};

export type StatusHolding = {
  asset: string;
  symbol: string;
  amountWei: string;
  decimals: number;
  usdValueE8: string;
  priceSource: string;
};

export type SessionKeyReport = {
  /** DB 記的最新那把（＝`GET /portfolios` 顯示的那把）。**可能沒安裝在鏈上。** */
  configured: { permissionId: string; keyRef: string; installed: boolean } | null;
  /** 排程器實際會用的那把（由新到舊逐把驗 `permissionConfig().signer`）。 */
  usable: { permissionId: string; keyRef: string } | null;
  /** 讀不到安裝狀態時的錯誤。`usable === null` **只有在 `error === null`** 時才可以讀成「沒有可用的 key」。 */
  error: string | null;
};

export type PortfolioStatus = {
  portfolioId: number;
  account: string;
  block: string;
  totalUsdE8: string;
  complete: boolean;
  holdings: StatusHolding[];
  unpriced: unknown[];
  targets: { asset: string; symbol: string; weightBps: number }[];
  drift: {
    grossDriftBps: number;
    maxAbsDeltaBps: number;
    needsRebalance: boolean;
    thresholdBps: number;
    assets: DriftAssetRow[];
  };
  blocked: unknown[];
  sessionKey?: SessionKeyReport | null;
};

/** 續期：後端用 master seed 派生好的那把新 key（含要在鏈上執行的 install calldata）。 */
export type RenewalParams = {
  portfolioId: number;
  strategyId: number;
  chainId: number;
  ownerAddress: string;
  accountAddress: string;
  executorAddress: string;
  entryPoint: string;
  kernelVersion: string;
  sessionKeyAddress: string;
  keyRef: string;
  validUntil: number;
  expiresAt: string;
  permissionId: string;
  policySnapshot: Record<string, unknown>;
  /** 打給帳戶自己的 install calldata（`msg.sender == self`）。 */
  initConfig: string[];
  /** 後端自己用的 alto 位址。**前端不要用它**（CORS），走 `/api/bundler` relay。 */
  bundlerUrl: string;
};

export type RenewalRecorded = {
  ok: true;
  recorded: { keyRef: string; permissionId: string };
  /** true = 這一把之前就記過了（重送不是錯誤）。 */
  duplicate?: true;
};

type RequestInitLite = {
  method?: 'GET' | 'POST';
  token?: string | null;
  body?: unknown;
  signal?: AbortSignal;
};

async function request<T>(path: string, init: RequestInitLite = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (cause) {
    // fetch 只有在**網路層**失敗時才會 throw；後端的錯誤一律是帶 status 的回應。
    throw new ApiError(0, 'NETWORK', `連不到後端：${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const holder = parsed as { error?: { code?: unknown; message?: unknown } } | null;
    const code = typeof holder?.error?.code === 'string' ? holder.error.code : `HTTP_${response.status}`;
    const message =
      typeof holder?.error?.message === 'string'
        ? holder.error.message
        : typeof parsed === 'string' && parsed.length > 0
          ? parsed
          : response.statusText;
    throw new ApiError(response.status, code, message);
  }

  return parsed as T;
}

/** 取得 SIWE challenge（不花錢、不需要認證）。 */
export function postNonce(): Promise<SiweChallenge> {
  return request<SiweChallenge>('/auth/nonce', { method: 'POST' });
}

/** 用簽好的 SIWE 訊息換 token。 */
export function postLogin(message: string, signature: string): Promise<SessionCredentials> {
  return request<SessionCredentials>('/auth/login', { method: 'POST', body: { message, signature } });
}

/**
 * ⚠ `GET /portfolios` 回的是 **`{ portfolios: [...] }`**，不是裸陣列。
 *
 * 這一行是踩過的坑：型別寫成 `Portfolio[]` 時 TypeScript 不會有任何意見（`request<T>` 是斷言），
 * 但執行期拿到的是物件 → `Array.isArray` 為 false → `.map` 直接 throw，畫面變成空白。
 * 契約錯誤只有「真的打一次」才抓得到，所以這裡把 wire 形狀寫出來，並且**在客戶端拆掉**。
 */
export type PortfolioList = { portfolios: Portfolio[] };

export function getPortfolios(token: string): Promise<Portfolio[]> {
  return request<PortfolioList>('/portfolios', { token }).then((body) => body.portfolios);
}

/** 派生一把新的 session key 並回傳組 UserOp 所需的一切（後端不簽章、不上鏈、不寫 DB）。 */
export function getRenewalParams(token: string, id: number, signal?: AbortSignal): Promise<RenewalParams> {
  return request<RenewalParams>(`/portfolios/${id}/renewal-params`, { token, signal });
}

/** 回報續期 UserOp 已上鏈，後端記進 `session_keys`（鏈才是權威）。 */
export function postRenewalResult(
  token: string,
  id: number,
  body: { keyRef: string; permissionId: string; validUntil: number; policySnapshot: Record<string, unknown> },
): Promise<RenewalRecorded> {
  return request<RenewalRecorded>(`/portfolios/${id}/renewal-result`, { method: 'POST', token, body });
}

/** 這個端點會掃 Transfer 日誌、讀池子、定價 —— 實測 2–3 秒，不是卡住。 */
export function getPortfolioStatus(token: string, id: number): Promise<PortfolioStatus> {
  return request<PortfolioStatus>(`/portfolios/${id}/status`, { token });
}
