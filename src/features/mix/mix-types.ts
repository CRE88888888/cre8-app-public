/**
 * My mix 的 API 形狀（cre8-app#132），照 backend#179／#181／#183 的 `GET /me/mixes`、`POST /mixes/preview` 等回應。
 * 呼叫在 `mix-api.ts`；測試用的範例回應在 `tests/fixtures/mix-fixtures.ts`。
 *
 * 單位：`*Raw` 是 18 位小數的 USDT 字串（chain 97）；`*Bps` 是萬分比（10000 = 100%），`returnBps` 是字串。
 */
export type Address = `0x${string}`;
export type MixAsset = { assetId: Address; weightBps: number };
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';
export type Rebalance = { frequency: Frequency; startDate: string };
export type Exit = { takeProfitBps: number | null; stopLossBps: number | null };

/** 百分比字串（8 位小數），例如 "12.34567890"。 */
export type ModelReturns = {
  asOf: string;
  d7: string | null;
  d30: string | null;
  d90: string | null;
  y1: string | null;
  all: string | null;
  annualized: string | null;
};
export type ClosePoint = { date: string; value: string };

export type MixStatus = 'awaiting_enrollment' | 'active' | 'exiting' | 'exited';
export type MixEventKind =
  | 'mix_enrolled'
  | 'mix_allocation_changed'
  | 'mix_rebalanced'
  | 'mix_switch_residual'
  | 'mix_exit_triggered'
  | 'mix_exit_stuck';

export type MixMarket = { assetId: Address; open: boolean; nextOpenAt: string | null };

export type MixDetail = {
  id: number;
  name: string;
  assets: MixAsset[];
  rebalance: Rebalance;
  createdAt: string;
  exit: Exit;
  shareCode: string;
  account: Address;
  portfolioId: number | null;
  strategyId: number;
  status: MixStatus;
  pendingChange: boolean;
  currentValueRaw: string | null;
  netInputRaw: string | null;
  returnBps: string | null;
  performanceInputRaw: string | null;
  performanceStartedAt: string;
  valuedAt: string | null;
  performanceMessage: string | null;
  nextRebalanceAt: string | null;
  residualCash: { amountRaw: string; reason: string | null; message: string } | null;
  markets: MixMarket[];
  selling: { assetId: Address; message: string }[];
  /** 新的在前，最多 30 筆。後端的 `message` 是中文，畫面用 `mix-copy.ts` 依 kind 寫英文。 */
  events: { id: string; at: string; kind: MixEventKind; message: string }[];
};

export type MixPreview = {
  minimumDepositRaw: string;
  modelReturns: ModelReturns | null;
  modelNav: ClosePoint[];
  modelComponents: { symbol: string; includedFrom: string | null }[];
  estimatedRebalanceCost: { swapFeeBps: number; gasWei: string | null; gasSponsored: boolean; message: string };
  markets: (MixMarket & { symbol?: string })[];
  message: string;
};

export type SharedMix = {
  name: string;
  assets: MixAsset[];
  rebalance: Rebalance;
  createdAt: string;
  exit: Exit;
  modelReturns: ModelReturns | null;
  modelNav: ClosePoint[];
  modelComponents: { symbol: string; includedFrom: string | null }[];
  copies: number;
};

export type CreateMixInput = {
  name?: string;
  assets?: MixAsset[];
  rebalance?: Partial<Rebalance>;
  exit?: Partial<Exit>;
  importCode?: string;
};

/** `POST /me/mixes` 201、`PATCH` 改成分時的回應：要讓用戶用帳戶 owner 簽一次的 calls。 */
export type MixSigningPayload = {
  mixId: number;
  strategyId: number;
  account: Address;
  signingMode: 'sudo';
  expectedVersion: number;
  nonce: string | null;
  expiresAt: string;
  calls: { to: Address; value: '0'; data: `0x${string}` }[];
  intentId: string;
  message: string;
  name?: string;
  shareCode?: string;
  /** 加息策略路由 v2 的地址（後端宣告；只有 v2 對象內的 owner 才有）。簽名前核對用，見 `mix-chain.ts`。 */
  strategyV2?: { registry: Address; executor: Address };
};

export type MixApiError = { code: string; message: string };
