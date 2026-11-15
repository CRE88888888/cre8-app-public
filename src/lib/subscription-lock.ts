/**
 * 主網先鎖住 typed（schema 1／2）基金的認購（cre8-app#93 high）。
 *
 * 後端的產品投入來源（迎新、每日領取記成 funding lot）只開在 chain 97。主網上把 USDT 直接轉進 typed 基金的帳戶，
 * 不會產生 lot，配置回 `NO_DUE_SLOT`：本金進去了、gas 花了，卻不會買。主網投入管線完成前，轉帳之前一定先問
 * `GET /portfolios/:id/execution` 的 `automation`，不是 `enabled` 就不轉。
 *
 *   - 還沒 enroll（新買家）：看策略的版本是不是 typed（`executionSchemaVersion` ≥ 1），是就連帳戶都不建。
 *   - 已經有帳戶：問 `/execution`。`automation: "enabled"` 才放行；回 409 `EXECUTION_VERSION_MISMATCH`
 *     表示是舊的目標比例基金（沒有 typed 版本），照舊放行；其他錯誤（讀不到）一律不轉，寧可請人稍後再試。
 * 測試網（錢由水龍頭給）不走這裡。
 */
import { ApiError } from './api';

export class SubscriptionLocked extends Error {
  readonly title = 'Buying is not open yet';
  readonly technical: string;
  constructor(reason: 'mainnet' | 'unknown', technical = '') {
    super(reason === 'mainnet'
      ? 'Buying this fund on BNB Chain opens soon. Nothing was transferred.'
      : 'We could not confirm this fund can take your purchase right now, so nothing was transferred. Please try again later.');
    this.name = 'SubscriptionLocked';
    this.technical = technical;
  }
}

/** 還沒建帳戶時：策略最新的版本是 typed 版本就先擋（不在主網建一個買不了的帳戶）。 */
export function typedVersionLocked(chain: { faucetFunded: boolean }, versions: readonly { executionSchemaVersion?: number | null }[] | undefined): boolean {
  if (chain.faucetFunded || versions === undefined || versions.length === 0) return false;
  const latest = versions.reduce((a, b) => ((b as { version?: number }).version ?? 0) > ((a as { version?: number }).version ?? 0) ? b : a);
  return (latest.executionSchemaVersion ?? 0) >= 1;
}

/** 已有帳戶：轉帳前問 `/execution`。不能投入就丟 `SubscriptionLocked`。 */
export async function assertSubscriptionOpen(
  chain: { faucetFunded: boolean },
  readExecution: () => Promise<{ automation?: string }>,
): Promise<void> {
  if (chain.faucetFunded) return;
  let execution: { automation?: string };
  try {
    execution = await readExecution();
  } catch (cause) {
    if (cause instanceof ApiError && cause.code.toUpperCase() === 'EXECUTION_VERSION_MISMATCH') return; // 舊的目標比例基金
    throw new SubscriptionLocked('unknown', cause instanceof ApiError ? `${cause.status} · ${cause.code}` : String(cause));
  }
  if (execution.automation !== 'enabled') throw new SubscriptionLocked('mainnet', `automation: ${execution.automation ?? 'missing'}`);
}
