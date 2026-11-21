/**
 * 後端 API 客戶端。形狀照 `backend/src/server.ts` 的實際實作：
 *   POST /auth/nonce  -> SiweChallenge（無外層 wrapper）
 *   POST /auth/login  -> { message, signature } → { token, expiresAt }
 *   GET  /portfolios  -> Portfolio[]（**直接是陣列**，不是 { portfolios: [...] }）
 *   所有錯誤都是 { error: { code, message } }
 *
 * 一律走相對路徑 `/api`（dev 由 vite proxy 轉到 127.0.0.1:8081）。同源就沒有 CORS 與 preflight。
 */

import { checkYieldBook, parseYieldMarkets } from './yield';
import { yieldBookFor } from './yield-book';
import type { YieldMarketList } from './yield';
import { MOCK_MARKETS_97, YIELD_MOCK } from './yield-mock';
import type { TypedVersionBody } from './fund-execution';
import type { ModelComponent, ModelReturns } from './model-history';
import { WAITLIST_PENDING, signalWaitlistPending } from './waitlist-signal';
import type { PackedSponsorOperation, SponsorResponse } from './paymaster';

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
  /** `strategies.name`（使用者取的基金名）。null = 這一列沒有 join 到策略，前端退回顯示 id。 */
  strategyName: string | null;
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
  configured: { permissionId: string; keyRef: string; installed: boolean; expiresAt: string | null; status: string | null } | null;
  /** 排程器實際會用的那把（由新到舊逐把驗 `permissionConfig().signer`）。 */
  usable: { permissionId: string; keyRef: string; expiresAt: string | null; status: string | null } | null;
  /** 讀不到安裝狀態時的錯誤。`usable === null` **只有在 `error === null`** 時才可以讀成「沒有可用的 key」。 */
  error: string | null;
};

export type PortfolioStatus = {
  portfolioId: number;
  /** executor 位址（approve 的 spender）。null = 這個部署沒設 EXECUTOR_ADDRESS。 */
  executorAddress: string | null;
  /**
   * 這個帳戶的原生幣 gas 狀態。**一個帳戶 = 一個「owner + 策略」組合**，所以 gas 是各自獨立的：
   * 這檔基金還能不能動，取決於它自己還有多少 BNB。
   * `null` = 查不到（RPC 掛），不是「餘額 0」。
   */
  gas: GasState;
  account: string;
  block: string;
  totalUsdE8: string;
  complete: boolean;
  holdings: StatusHolding[];
  unpriced: unknown[];
  targets: { asset: string; symbol: string; weightBps: number }[];
  /** 價格或 RPC 不完整時後端回 `null`（cre8-app#93）：讀之前一定要先檢查。 */
  drift: {
    grossDriftBps: number;
    maxAbsDeltaBps: number;
    needsRebalance: boolean;
    thresholdBps: number;
    assets: DriftAssetRow[];
  } | null;
  blocked: unknown[];
  sessionKey?: SessionKeyReport | null;
  /**
   * registry 上這個帳戶的暫停旗標（1 = Safe、2 = 平台 operator、4 = 帳戶自己），與解好的來源。
   * `null` = 讀不到；欄位不存在 = 後端還沒有這個功能（A10 之前）。
   */
  pauseFlags?: number | null;
  pauseSources?: ('safe' | 'operator' | 'account')[] | null;
  /**
   * P11（backend#126）：這個投組加入時的版本與目前生效版本不同，等轉版前暫停買入；沒暫停是 null 或沒有這個欄位。
   * 讀之前用 `parseBuyingPaused` 檢查形狀。不影響 complete、估值、持倉或退出。
   */
  buyingPaused?: unknown;
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
  method?: 'GET' | 'POST' | 'PATCH';
  token?: string | null;
  body?: unknown;
  signal?: AbortSignal;
  /** 額外標頭（My mix 建立要帶 `Idempotency-Key`）。 */
  headers?: Record<string, string>;
};

/** 給各功能自己的 API 檔用（例如 `features/mix/mix-api.ts`）：同一套錯誤格式與 `ApiError`。 */
export function apiRequest<T>(path: string, init: RequestInitLite = {}): Promise<T> {
  return request<T>(path, init);
}

async function request<T>(path: string, init: RequestInitLite = {}): Promise<T> {
  return (await requestWithStatus<T>(path, init)).body;
}

/** 同 `request`，另外回 HTTP 狀態（202 這類「成功但還沒好」要分開處理時用）。 */
async function requestWithStatus<T>(path: string, init: RequestInitLite = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { ...init.headers };
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
    throw new ApiError(0, 'NETWORK', `Cannot reach the backend: ${cause instanceof Error ? cause.message : String(cause)}`);
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
    // waitlist 閘門擋下（backend#134）：通知 WaitlistGate 清 session、重新問名單，畫面回到 waitlist。
    if (response.status === 403 && code === WAITLIST_PENDING) signalWaitlistPending();
    throw new ApiError(response.status, code, message);
  }

  return { status: response.status, body: parsed as T };
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
 * 用 Privy 的 identity token 換 CRE8 session（backend#65，`POST /auth/privy`）。
 *
 * 回應與 SIWE 相同（`{ token, expiresAt }`）。**目前沒有主人地址**：`address` 是預留的 ——
 * 後端哪天帶了就以它為準，沒有就由前端從 Privy 帳號推回去（`lib/privy-owner.ts` 的 `resolveOwner`）。
 *
 * 會回的錯誤：401（token 無效或過期）、409 `PRIVY_NO_WALLET`／`PRIVY_OWNER_AMBIGUOUS`
 * （首次登入時帳號上不是恰好一個 EVM 錢包）、503 `PRIVY_UNAVAILABLE`（後端沒設定 Privy）。
 */
export function postPrivyLogin(identityToken: string, signal?: AbortSignal): Promise<SessionCredentials & { address?: string }> {
  return request<SessionCredentials & { address?: string }>('/auth/privy', { method: 'POST', body: { identityToken }, ...(signal === undefined ? {} : { signal }) });
}

/**
 * 向平台要一筆 UserOp 的代付簽名（backend#68，`POST /paymaster/sponsor`，只在測試網）。
 * 被拒時是 `ApiError`，`code` 是 `PAYMASTER_*`；白話訊息見 `lib/paymaster.ts` 的 `explainSponsorFailure`。
 */
export function postSponsor(token: string, userOperation: PackedSponsorOperation): Promise<SponsorResponse> {
  return request<SponsorResponse>('/paymaster/sponsor', { method: 'POST', token, body: { userOperation } });
}

/** 一筆記帳的投入（backend BE-2 的 funding lot；只列前端會用到的欄位）。 */
export type FundingLot = {
  id: string;
  txHash: string | null;
  amountRaw: string;
  /** true：這筆之前就記過了（重送同一個來源），這次沒有新的錢。 */
  replayed?: boolean;
  fundingStatus?: 'scheduled' | 'waiting_for_merged_budget' | 'recorded';
};

/**
 * `POST /portfolios/:id/buy-funding`（backend#94，只在 chain 97）：第一次買入前呼叫。帳戶裡沒有 USDT、這個人也還沒領過
 * 迎新，後端會 mint 10,000 測試 USDT 進基金帳戶並記成一筆投入（每人一輩子一次）。
 *   - 200 `ready`：`funding: "welcome_grant"`（迎新，`lot.replayed` 表示之前就記過）或 `"existing_cash"`（帳戶裡已有錢，`lot: null`）。
 *   - 202 `pending`：迎新交易已送出、結果還不知道；只能稍後重送同一個請求，不能當成已投入。
 *   - 409 `DAILY_FAUCET_REQUIRED`：迎新給了別檔、失敗，或在這檔用完了；改用每日領取。
 */
export type BuyFunding =
  | { state: 'ready'; funding: 'welcome_grant' | 'existing_cash'; lot: FundingLot | null }
  | { state: 'pending'; funding: 'welcome_grant'; grantId: string; txHash: string | null; lot: null };
export function postBuyFunding(token: string, portfolioId: number): Promise<BuyFunding> {
  return request(`/portfolios/${portfolioId}/buy-funding`, { method: 'POST', token, body: {} });
}

/** `POST /portfolios/:id/funding-lots`：把每日領取的那一筆（claimId）記成這檔基金的投入。重送同一個 claim 不會重記。 */
export function postFundingLot(
  token: string,
  portfolioId: number,
  // wallet_transfer：測試網用錢包 USDT 轉進基金帳戶的那一筆（cre8-app#114；後端從收據驗證 from／to／金額）。
  source: { kind: 'faucet_claim'; claimId: string } | { kind: 'wallet_transfer'; txHash: string },
): Promise<FundingLot> {
  return request(`/portfolios/${portfolioId}/funding-lots`, { method: 'POST', token, body: { source } });
}

/**
 * 測試網：替登入者的主人錢包補一點 tBNB，好付「錢包 → 基金帳戶」那一筆 USDT 轉帳的手續費（cre8-app#114）。
 * 餘額夠時後端回 `txHash: null`。只在測試網。
 */
export function postGasFaucet(token: string): Promise<{ txHash: string | null; amountWei: string }> {
  return request('/faucet/gas', { method: 'POST', token, body: {} });
}

/**
 * 領測試 USDT（backend#72，`POST /faucet/usdt`，只在測試網）。
 * `account` 是**已經 enroll 的基金帳戶**（不是使用者的錢包）。200＝已確認、202＝結果未知（`state: "unknown"`）；
 * 502（交易被退回）會以 `ApiError` 丟出。介面見 `lib/faucet.ts`。
 */
export function postFaucetUsdt(
  token: string,
  account: string,
): Promise<{ claimId?: string; state?: 'confirmed' | 'failed' | 'unknown'; txHash?: string; amountWei?: string }> {
  return request('/faucet/usdt', { method: 'POST', token, body: { account } });
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

/**
 * `POST /portfolios/:id/rebalance` —— **operator 端點**：真的用 session key 送一筆鏈上交易。
 *
 * 規劃（要換什麼、換多少）由後端決定，前端不知道也不該猜：回應裡的 `steps` 才是這一輪實際送的參數。
 *
 * ⚠ 後端預設**關閉**（fail-closed）：回 403 `OPERATOR_REBALANCE_DISABLED`，要開得在後端帶
 * `ENABLE_OPERATOR_REBALANCE=true`。那個 403 不是「權限不足」，是「這個部署沒打算讓人手動觸發」。
 */
export type RebalanceOutcome = 'executed' | 'noop' | 'blocked' | 'reverted' | 'failed';

export type RebalanceStep = {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOutMin: string;
  /**
   * 這一步實際呼叫的 router 位址（A11，backend#47）：PancakeSwap Universal Router 或 KyberSwap。
   * 欄位不存在 = 後端還沒有這個功能。顯示名稱見 `lib/venues.ts`。
   */
  venue?: string;
};

export type RebalanceResult = {
  portfolioId: number;
  outcome: RebalanceOutcome;
  /** 排程器寫的那一句話（含哪一層沒過）。**原文照回**，不改寫成「失敗」。 */
  reason: string;
  txHash: string | null;
  userOpHash: string | null;
  /** receipt 裡 executor 發出的 `SwapExecuted` 筆數。null = 有 tx 但讀不到 receipt。 */
  swapExecuted: number | null;
  /** 這一輪規劃了幾個 step（＝應該有幾筆 SwapExecuted）。 */
  expectedSwaps: number;
  gasUsed: string | null;
  steps: RebalanceStep[];
};

/**
 * `GET /portfolios/:id/plan` —— **dry-run** 預覽：這一輪會做什麼、不會做什麼、以及為什麼。
 *
 * 慢（實測 2–3 秒：要讀鏈、估價、算 impact），但它回答的是「現在按下去會怎樣」——
 * 而那正是使用者在按下按鈕之前唯一需要知道的事。唯讀，不受 `ENABLE_OPERATOR_REBALANCE` 限制。
 */
export type RebalancePlanPreview = {
  portfolioId: number;
  outcome: 'ready' | 'noop' | 'blocked';
  /** 排程器寫的那一句話，原文。 */
  reason: string;
  steps: RebalanceStep[];
};

export function getRebalancePlan(token: string, id: number): Promise<RebalancePlanPreview> {
  return request<RebalancePlanPreview>(`/portfolios/${id}/plan`, { token });
}

export function postRebalance(token: string, id: number): Promise<RebalanceResult> {
  return request<RebalanceResult>(`/portfolios/${id}/rebalance`, { method: 'POST', token });
}

/** `GET /assets` — 可定價資產（create fund 的選單來源，不在前端寫死）。 */
export type PriceableAsset = {
  address: string;
  symbol: string;
  decimals: number;
  /** true = 計價基準幣（USDT）。策略的每一條腿都是「資產 ↔ numeraire」。 */
  isNumeraire: boolean;
  /**
   * executor 的 oracle router 有沒有為它註冊 per-pair oracle。
   * `false` = 合約會 revert `OracleNotSet`，買不進去也賣不掉；`null` = 查不到（未知）。
   */
  tradable: boolean | null;
};

export function getAssets(token: string): Promise<PriceableAsset[]> {
  return request<{ assets: PriceableAsset[] }>('/assets', { token }).then((body) => body.assets);
}

/** 建立策略（名稱等）。後端會同時鏡像到鏈上 Registry。 */
export function createStrategy(
  token: string,
  body: { name: string; description?: string; isPublic?: boolean },
): Promise<{ id: number; [key: string]: unknown }> {
  return request('/strategies', { method: 'POST', token, body });
}

/**
 * 發一個 typed 版本（backend BE-2 schema 2，`docs/strategy-api.zh-TW.md`）：每個資產各自 hold／stack、排程 `funding`、
 * 不再平衡、生息關閉。本文由 `lib/fund-execution.ts` 的 `typedVersionBody` 組（權重剛好 10000、USDT 沒有執行設定）。
 * 舊的 `schedule: interval`（目標比例再平衡）後端已經不收新的 HTTP 發版。
 */
export function publishVersion(
  token: string,
  strategyId: number,
  body: TypedVersionBody,
): Promise<PublishedVersion> {
  return request(`/strategies/${strategyId}/versions`, { method: 'POST', token, body });
}

/** `POST /strategies/:id/versions` 讀回的版本（只列前端會用到的欄位）。 */
export type PublishedVersion = {
  strategyId: number;
  version: number;
  /** 0 = 0031 以前的舊列（目標比例）；1 = canonical config v1。 */
  executionSchemaVersion?: number;
  execution?: { kind: 'hold' | 'stack' | 'target_weight' };
  executionChainId?: number | null;
  /** 放進鏈上 `Version.scheduleHash` 的設定雜湊；舊列是 null。 */
  configHash?: string | null;
  idleYield?: { enabled: boolean };
  /** 這一版生效的時間（ISO）。P11 是發版時決定的（後端預設＋24h＋60 秒，重試沿用原值）。 */
  activeAt?: string | null;
  [key: string]: unknown;
};

/** `POST /strategies/preview-contribution` 的回應（backend#123）。raw 都是 18 decimals 的十進位字串。 */
export type ContributionPreview = {
  minimumRaw: string;
  /** 每個非現金資產（地址）這筆投入實際分幾期；純現金是空的。 */
  effectiveSlices: Record<string, number>;
  /** 前三個合併時點與最後一個（UTC ISO）。 */
  slots: { at: string; budgetRaw: string }[];
};

/** 預覽的本文：execution 與發布版本同 schema（含完整 cash 項）；amountRaw 是 uint256 十進位字串。 */
export type ContributionPreviewBody = { chainId: number; execution: TypedVersionBody['execution'] | Record<string, unknown>; amountRaw: string };

/**
 * 入金期數預覽（不需登入、不讀寫 DB）。目前後端只收 chain 97 的 schema 2；其他鏈由呼叫端擋（lib/contribution-preview.ts）。
 * 錯誤：422 BELOW_MINIMUM_ALLOCATION／PREVIEW_AMOUNT_TOO_LARGE／BELOW_MIN_BATCH、400 格式、429 RATE_LIMITED、
 * 503 PREVIEW_TIMEOUT／PREVIEW_UNAVAILABLE／MIN_FEE_UNAVAILABLE。
 */
export function postPreviewContribution(body: ContributionPreviewBody, signal?: AbortSignal): Promise<unknown> {
  return request<unknown>('/strategies/preview-contribution', { method: 'POST', body, ...(signal === undefined ? {} : { signal }) });
}

/**
 * 取消這檔策略尚未生效的新版本（P11，cre8-contracts#54 `cancelVersion`）。鏈上的 provider 是平台 operator，
 * 所以由後端代送；只有建立者能叫。路徑照 backend#124 暫定，定案後只改這裡。
 * 生效前才能取消；取消不重設 7 天發版間隔。
 */
export function cancelPendingVersion(token: string, strategyId: number): Promise<{ ok: true; [key: string]: unknown }> {
  return request(`/strategies/${strategyId}/versions/cancel`, { method: 'POST', token, body: {} });
}

/**
 * P11 首次加入（chain 97，backend#126）第一步：後端由 operator 先部署帳戶（地址不變、owner 仍是使用者），
 * 回帳戶地址、預期版本等。還沒部署好回 202，要重試同一個請求（`lib/first-enroll.ts` 的 `waitForPreparation`）。
 * 欄位以 backend#126 為準；這裡只讀前端用得到的。
 */
export function prepareEnrollment(token: string, strategyId: number): Promise<{ status: number; body: unknown }> {
  return requestWithStatus<unknown>('/portfolios/enrollment-params', { method: 'POST', token, body: { strategyId } });
}

/** P11 首次加入最後一步：本人的 enroll UserOp 上鏈後，請後端讀鏈上 enrollments 確認並建立投組。 */
export function confirmEnrollment(token: string, strategyId: number): Promise<Portfolio> {
  return request<Portfolio>('/portfolios/enrollment-confirm', { method: 'POST', token, body: { strategyId } });
}

/** 把策略 enroll 成一個投組（會部署 smart account、上鏈）。 */
export function enrollPortfolio(token: string, strategyId: number): Promise<Portfolio> {
  return request<Portfolio>('/portfolios', { method: 'POST', token, body: { strategyId } });
}

/**
 * `GET /portfolios/:id/execution`（BE-2）：typed 基金的執行狀態。前端只用 `automation`：
 * `"enabled"` 才表示這條鏈的產品投入管線開著（目前只有 chain 97）。舊的目標比例基金回 409 `EXECUTION_VERSION_MISMATCH`。
 */
export function getPortfolioExecution(token: string, id: number): Promise<{ automation?: 'enabled' | 'testnet_only' | string; [key: string]: unknown }> {
  return request(`/portfolios/${id}/execution`, { token });
}

/**
 * 生息（APP-3）。BE-3／BE-4 還沒開出來，路徑與欄位照 C3 在 backend#84 的留言暫定，後端定案後只改這裡與 `lib/yield.ts` 的 parse。
 *
 * - `GET /yield/markets?chainId=`（公開，不用登入：設計器不用登入）→ `{ chainId, registry, markets[] }`
 * - 每資產生息狀態在 `GET /portfolios/:id/execution` 的 `yield`（見 `parsePortfolioYield`）
 * - `POST /portfolios/:id/yield/consent`、`/yield/exit`：owner 在鏈上簽完之後告訴後端（帶 txHash），後端據此排存入／領回。
 *
 * 後端還沒有這些端點時回 404：市場清單當成「這條鏈沒有生息」，畫面維持「Coming soon」。
 */
export async function getYieldMarkets(chainId: number, signal?: AbortSignal): Promise<YieldMarketList | null> {
  // 只有 chain 97 有生息（審查第 2 項）：其他鏈不發請求；回應也要是這條鏈、而且整份對得上地址簿（第 1 項）。
  const book = yieldBookFor(chainId);
  if (book === null) return null;
  if (YIELD_MOCK) return checkYieldBook(MOCK_MARKETS_97, book);
  let body: unknown;
  try {
    body = await request<unknown>(`/yield/markets?chainId=${chainId}`, signal === undefined ? {} : { signal });
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return null;
    throw cause;
  }
  const list = parseYieldMarkets(body);
  return list === null ? null : checkYieldBook(list, book);
}

export function postYieldConsent(token: string, id: number, body: { markets: string[]; txHash: string }): Promise<{ ok: true }> {
  return request(`/portfolios/${id}/yield/consent`, { method: 'POST', token, body });
}

/** 取消同意（只停新存入，不領回）：owner 先簽 `setYieldPolicy(..., false)`，再通知後端（backend#103）。 */
export function postYieldRevoke(token: string, id: number, body: { markets: string[]; txHash: string }): Promise<{ ok: true }> {
  return request(`/portfolios/${id}/yield/revoke`, { method: 'POST', token, body });
}

export function postYieldExit(token: string, id: number, body: { markets: string[]; txHash: string }): Promise<{ ok: true }> {
  return request(`/portfolios/${id}/yield/exit`, { method: 'POST', token, body });
}

/** 這個端點會掃 Transfer 日誌、讀池子、定價 —— 實測 2–3 秒，不是卡住。 */
export function getPortfolioStatus(token: string, id: number): Promise<PortfolioStatus> {
  return request<PortfolioStatus>(`/portfolios/${id}/status`, { token });
}

/** 這個投組最近的執行紀錄（含前後快照的漂移與總值）。 */
export function getPortfolioActivity(token: string, portfolioId: number): Promise<{ activity: PortfolioActivity[] }> {
  return request(`/portfolios/${portfolioId}/activity`, { token });
}

export type PortfolioActivity = {
  id: number;
  state: string;
  txHash: string | null;
  userOpHash: string | null;
  attempts: number;
  createdAt: string;
  driftBeforeBps: number | null;
  driftAfterBps: number | null;
  usdBeforeE8: string | null;
  usdAfterE8: string | null;
};

// ---------------------------------------------------------------------------
// Operator 總覽（rebalance dashboard）
// ---------------------------------------------------------------------------

export type OperatorRow = {
  id: number;
  strategyId: number;
  strategyName: string | null;
  version: number;
  scheduleState: string;
  /** 擁有人的錢包地址。與 `account`（Kernel counterfactual 地址）是**兩個不同**的地址。 */
  wallet: string;
  account: string | null;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  /** 最新快照的觀測點；`null` = 從來沒跑過一輪（不是「0 漂移」）。 */
  observedAt: string | null;
  driftBps: number | null;
  /**
   * 帳戶價值是 0（資金已全部提出，或還沒入金）。
   *
   * 空倉時 `driftBps` 仍然是公式算出來的大數字（空帳戶「完全不在目標上」），
   * 但把它顯示成「9999 bps / rebalance due」會讓人以為壞了 —— 它只是空。
   */
  isEmpty: boolean;
  totalUsdE8: string | null;
  needsRebalance: boolean | null;
  gasWei: string | null;
  sessionKeyExpiresAt: string | null;
  lastOperation: { id: number; state: string; txHash: string | null; createdAt: string } | null;
};

export type SchedulerStatus = {
  startedAt: string;
  lastRoundAt: string | null;
  lastFinishedAt: string | null;
  rounds: number;
  dryRun: boolean;
  roundLimit: number;
  thresholdBps: number;
  intervalSeconds: number;
  lastSummary: Record<string, number>;
  lastError: string | null;
  pid: number | null;
  staleSeconds: number | null;
  alive: boolean;
};

export type OperatorOverview = {
  generatedAt: string;
  /** `null` = 排程器從來沒跑過（不是「死了」）。 */
  scheduler: SchedulerStatus | null;
  alerts: { critical: number; warn: number; open: number } | null;
  lastCheckedAt: string | null;
  portfolios: OperatorRow[];
};

/**
 * Waitlist（使用者 2026-11-16，backend#127）：用 Privy identity token 加入自己的排隊（冪等，也回目前狀態）。
 * 排隊的人還沒有 CRE8 session，所以不帶 CRE8 bearer；後端從 Privy 的 X 帳號取 handle，不信任前端。
 * 回 `{ status: 'waiting' | 'approved', xHandle, joinedAt }`（撤回的對外也是 waiting）；`lib/waitlist.ts` 的 `parseWaitlist` 讀。
 * 409 `X_REQUIRED`（帳號沒綁 X）、409 `X_ALREADY_JOINED`（這個 X 帳號已被另一個登入方式佔用）。
 */
export function postWaitlistJoin(identityToken: string, signal?: AbortSignal): Promise<unknown> {
  return request<unknown>('/waitlist/join', { method: 'POST', body: { identityToken }, ...(signal === undefined ? {} : { signal }) });
}

/**
 * 用邀請碼加入（backend#131）：`POST /waitlist/redeem { identityToken, code }`，成功回應同 `/waitlist/join`（approved）。
 * 碼的問題：404 INVITE_INVALID、409 INVITE_USED、410 INVITE_EXPIRED、409 ALREADY_APPROVED（已放行，不消耗碼）；
 * 沒有 X 是 409 X_REQUIRED；限流 429。
 */
export function postWaitlistRedeem(identityToken: string, code: string, signal?: AbortSignal): Promise<unknown> {
  return request<unknown>('/waitlist/redeem', { method: 'POST', body: { identityToken, code }, ...(signal === undefined ? {} : { signal }) });
}

/** 營運看的一列排隊紀錄（backend#127）。 */
export type WaitlistEntry = { id: string; xHandle: string; xUserId: string | null; joinedAt: string; status: 'waiting' | 'approved' | 'revoked'; approvedAt: string | null };

/** 營運名單：依狀態篩、cursor 分頁（`nextCursor` 為 null 表示沒有下一頁）。 */
export function getOperatorWaitlist(
  token: string,
  status: 'waiting' | 'approved' | 'revoked' | 'all' = 'all',
  cursor: string | null = null,
  limit = 100,
): Promise<{ items: WaitlistEntry[]; nextCursor?: string | null }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (status !== 'all') query.set('status', status);
  if (cursor !== null) query.set('cursor', cursor);
  return request(`/operator/waitlist?${query.toString()}`, { token });
}

/** 一批剛產生的邀請碼（backend#132）：明碼只在這一次回應出現，之後查不到。 */
export type InviteBatch = { batchId: string; issuedTo: string | null; batchNote: string | null; expiresAt: string | null; items: { id: string; code: string }[] };
export type InviteStatus = 'unused' | 'used' | 'revoked' | 'expired';
/** 營運列表的一筆邀請碼（碼一律遮罩，不回明碼或雜湊）。 */
export type InviteRow = {
  id: string; codeMasked: string; batchId: string; batchNote: string | null; issuedTo: string | null; status: InviteStatus;
  createdBy: string | null; createdAt: string; expiresAt: string | null; usedByWaitlistId: string | null; xHandle: string | null;
  usedAt: string | null; revokedAt: string | null; revokedBy: string | null;
};

/** 產生一批邀請碼：count 1–500；issuedTo、batchNote 可空；expiresAt 是未來的 UTC ISO 時間或 null。 */
export function createOperatorInvites(
  token: string,
  body: { count: number; issuedTo?: string | null; batchNote?: string | null; expiresAt?: string | null },
): Promise<InviteBatch> {
  return request('/operator/waitlist/invites', { method: 'POST', token, body });
}

/** 列出邀請碼：依狀態、批次篩，cursor 分頁（最多 100 筆一頁）。 */
export function getOperatorInvites(
  token: string,
  options: { status?: InviteStatus | 'all'; batch?: string | null; cursor?: string | null; limit?: number } = {},
): Promise<{ items: InviteRow[]; nextCursor: string | null }> {
  const { status = 'all', batch = null, cursor = null, limit = 100 } = options;
  const query = new URLSearchParams({ limit: String(limit) });
  if (status !== 'all') query.set('status', status);
  if (batch !== null) query.set('batch', batch);
  if (cursor !== null) query.set('cursor', cursor);
  return request(`/operator/waitlist/invites?${query.toString()}`, { token });
}

/** 依 issuedTo 彙總：發了幾個、用掉幾個（計數是十進位字串）。 */
export function getOperatorInviteSummary(token: string, batch: string | null = null): Promise<{ items: { issuedTo: string | null; issued: string; used: string }[] }> {
  return request(`/operator/waitlist/invites/summary${batch === null ? '' : `?batch=${encodeURIComponent(batch)}`}`, { token });
}

/** 作廢一個還沒用掉的碼（不影響已放行的人）。 */
export function revokeOperatorInvite(token: string, id: string): Promise<{ id: string; status: 'revoked' }> {
  return request(`/operator/waitlist/invites/${encodeURIComponent(id)}/revoke`, { method: 'POST', token, body: {} });
}

/** 放行或撤回一筆排隊紀錄。 */
export function setOperatorWaitlist(token: string, id: string, action: 'approve' | 'revoke'): Promise<{ ok: true }> {
  return request(`/operator/waitlist/${encodeURIComponent(id)}/${action}`, { method: 'POST', token, body: {} });
}

export function getOperatorOverview(token: string): Promise<OperatorOverview> {
  return request<OperatorOverview>('/operator/overview', { token });
}

// ---------------------------------------------------------------------------
// 策略（mandate）
// ---------------------------------------------------------------------------

export type StrategyAllocationAsset = { address: string; weightBps: number };

export type StrategyVersion = {
  strategyId: number;
  version: number;
  /** 0 = 舊的目標比例；1、2 = typed 版本（2 是逐資產）。舊後端沒有這個欄位。 */
  executionSchemaVersion?: number;
  allocation: { assets: StrategyAllocationAsset[] };
  schedule: { kind: 'interval'; intervalSeconds: number } | { kind: 'cron'; cron: string };
  /** typed 版本的執行設定（schema 2 是 `per_asset`，逐資產 hold／stack）；買家頁讀 stack 期數算每期金額（`stackBuys`）。 */
  execution?: unknown;
  changeLog: string | null;
  activeAt: string | null;
  createdAt: string;
  /** P11（backend#124）：還沒生效的版本。後端欄位未上線前不存在。 */
  pending?: boolean;
  /** P11：登入的人（建立者本人）現在能不能取消這一版。 */
  canCancel?: boolean;
  /** P11：這一版的績效費（bps）。 */
  performanceFeeBps?: number;
};

export type StrategyDetail = {
  id: number;
  provider: string;
  name: string;
  description: string;
  isPublic: boolean;
  swapFeeBps: number;
  createdAt: string;
  onchainId: number | null;
  category?: string | null;
  catalogKey?: string | null;
  /** 模型淨值（backend#173／#175）：日線、由舊到新、最多兩年；value 是十進位字串。沒有資料是 []。 */
  modelNav?: { date: string; value: string | number }[] | null;
  modelReturns?: ModelReturns | null;
  /** 每個成分從哪天起計入回測（backend#177）；includedFrom 是 null＝還沒計入。 */
  modelComponents?: ModelComponent[] | null;
  versions: StrategyVersion[];
};

export function getStrategy(token: string, id: number): Promise<StrategyDetail> {
  return request<StrategyDetail>(`/strategies/${id}`, { token });
}

/** 策略列表（`GET /strategies`，公開資料，帶分頁）。 */
export type StrategySummary = {
  id: number;
  provider: string;
  name: string;
  description: string;
  isPublic: boolean;
  swapFeeBps: number;
  createdAt: string;
  onchainId: number | null;
  /** 首發分類（backend#170）：theme／person／leveraged；舊資料是 null，舊後端沒有這個欄位。見 `lib/fund-categories.ts`。 */
  category?: string | null;
  /** 參考目錄的穩定識別碼（backend#170），例如 Mag7 是 `mag7`；沒有對應是 null。 */
  catalogKey?: string | null;
  /** 模型報酬（backend#174）：卡片讀 `annualized`。見 `lib/model-history.ts`。 */
  modelReturns?: ModelReturns | null;
};

export function listStrategies(token: string): Promise<{ items: StrategySummary[]; total: number }> {
  // 後端的上限是 100（超過回 400 INVALID_PAGINATION）。
  return request('/strategies?limit=100', { token });
}

/**
 * 把部位**按比例**賣成 numeraire（提領成 USDT 的前半段）。
 *
 * 按比例賣 → 賣完每個資產的權重不變 → 投組仍貼著 mandate，排程器不會立刻買回來。
 * 後半段是 owner-signed 的 USDT transfer（前端接著送）。
 */
export type RedeemResult = {
  portfolioId: number;
  outcome: 'executed' | 'noop' | 'blocked' | 'reverted' | 'failed';
  reason: string;
  txHash: string | null;
  steps: RebalanceStep[];
  redeemedUsdE8: string;
  /**
   * 還沒賣的非現金名義額（美元，E8 整數字串），可以直接帶回 `sellUsdE8` 續做（backend#40）。
   * `"0"` = 這一筆賣完了；`null` = 在規劃前就被擋下，不知道還剩多少（不是 0）；
   * 欄位不存在 = 後端還沒有分批（當成一批賣完）。
   */
  remainingUsdE8?: string | null;
  /** true = 這一批因為單筆上限只賣了一部分。 */
  batched?: boolean;
};

export function redeemPortfolio(token: string, id: number, usd: number): Promise<RedeemResult> {
  return request<RedeemResult>(`/portfolios/${id}/redeem`, { token, method: 'POST', body: { usd } });
}

/**
 * 分批提領的續做：把上一批回報的 `remainingUsdE8` 原樣帶回去（backend#40 的續作契約）。
 *
 * 首批用 `redeemPortfolio`（送 `usd`，後端按比例換算要賣多少）；之後每一批都用這一支。
 * **不可以**再送一次原本的 `usd`：那會被當成一筆新的提領，重新按比例計算。
 */
export function continueRedeem(token: string, id: number, sellUsdE8: bigint): Promise<RedeemResult> {
  return request<RedeemResult>(`/portfolios/${id}/redeem`, {
    token,
    method: 'POST',
    body: { sellUsdE8: sellUsdE8.toString() },
  });
}

/**
 * 清倉：把**全部**部位賣成 numeraire（後端 `POST /portfolios/:id/close`）。
 *
 * 與 `redeemPortfolio` 同一條管線，差別只在比例：這一支賣 100%，所以投組會被清空。
 * 賣不掉的部分會留在帳戶裡 —— 前端接著用 `sendSweep` 把它們直接轉回錢包。
 */
export function closePosition(token: string, id: number): Promise<RedeemResult> {
  return request<RedeemResult>(`/portfolios/${id}/close`, { token, method: 'POST' });
}

/**
 * 營運端：手動觸發某一輪再平衡（**不檢查 owner**）。
 *
 * 使用者端的是 `POST /portfolios/:id/rebalance`（要求你是那個投組的 owner）；
 * 營運端要跑別人的投組，所以走 `/operator/...`。鏈上規則不變（session key 的 UserOp、
 * executor 的 enrollment/allowlist/oracle 地板），這支只能「叫排程器跑一輪」。
 */
export function operatorForceRebalance(token: string, id: number): Promise<RebalanceResult> {
  return request<RebalanceResult>(`/operator/portfolios/${id}/rebalance`, { token, method: 'POST' });
}

/**
 * 營運端全域活動流：誰（owner 錢包）在哪個策略上被處理、成功或失敗、前後漂移。
 *
 * 為什麼不是 `/portfolios/:id/activity`：那一支要求你是該投組的 owner。營運端要看全部。
 */
export type OperatorActivityRow = {
  id: number;
  portfolioId: number;
  /** owner 錢包。 */
  wallet: string;
  strategyId: number;
  strategyName: string | null;
  type: string;
  state: string;
  txHash: string | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  driftBeforeBps: number | null;
  driftAfterBps: number | null;
  usdBeforeE8: string | null;
  usdAfterE8: string | null;
};

export function getOperatorActivity(
  token: string,
  limit = 50,
): Promise<{ activity: OperatorActivityRow[] }> {
  return request<{ activity: OperatorActivityRow[] }>(`/operator/activity?limit=${limit}`, { token });
}

/**
 * `GET /platform/status`（公開、免登入）—— 平台層級的鏈上狀態（backend#44）。
 * 讀鏈失敗時後端回 503，`globalPaused`／`maxBuyBps`／`block` 都是 null。
 */
export type PlatformStatus = {
  chainId: number;
  executor: string | null;
  registry: string | null;
  globalPaused: boolean | null;
  maxBuyBps: number | null;
  checkedAt: string;
  block: string | null;
};

/**
 * 從 `/platform/status` 的回應判斷平台是不是全域暫停。
 *
 * 只有「HTTP 200 而且 `globalPaused` 是布林值」才算知道答案；其他一律是 `null`（不知道）：
 * 503（後端讀不到鏈）、A 段臨時網址的 `PREVIEW_ONLY`、被導到 SPA 的 HTML、壞掉的 JSON、欄位缺漏。
 * **`null` 不可以當成 false**：不知道就是不知道，不能說成「沒有暫停」。
 */
export function platformPausedFrom(status: number, text: string): boolean | null {
  if (status !== 200) return null;
  try {
    const body = JSON.parse(text) as Partial<PlatformStatus> | null;
    return typeof body?.globalPaused === 'boolean' ? body.globalPaused : null;
  } catch {
    return null;
  }
}

/** `GET /platform/status` 的原始回應（地址簿一致性檢查用，`lib/address-book-check.ts`）。網路失敗會丟錯。 */
export async function getPlatformStatusText(): Promise<{ status: number; text: string }> {
  const response = await fetch(`${BASE}/platform/status`);
  return { status: response.status, text: await response.text() };
}

/** 平台現在是不是全域暫停：`true`／`false` = 確定，`null` = 不知道（含網路失敗）。不丟錯。 */
export async function getPlatformPaused(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await fetch(`${BASE}/platform/status`, signal === undefined ? {} : { signal });
    return platformPausedFrom(response.status, await response.text());
  } catch {
    return null;
  }
}

