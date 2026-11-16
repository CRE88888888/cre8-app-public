/**
 * 功能開關（cre8-app#58）：**每一項還不能用的功能在這一個檔案裡開／關**。
 *
 * 測試網要把主網會有的功能都放在畫面上，讓用戶與投資人看到完整產品；還不能用的顯示成灰色、
 * 標上「Mainnet」或「Coming soon」、點不動、不送任何請求。之後要開放某一項，改這裡的 `state`
 * （或部署時用 `VITE_FEATURES` 覆寫）就好，不用去各個頁面找。
 *
 * 四種狀態：
 * - `on`      可以用。畫面上沒有任何標記。
 * - `mainnet` 主網才開放（刷卡入金、其他鏈轉入、Ondo 冷門股）。標「Mainnet」。
 * - `soon`    還沒做好（限價／停利停損、逢低買、區間、順勢、做市、借貸、持有期間出借、閒置 USDT 生息、績效費、24 小時生效）。標「Coming soon」。
 * - `later`   設計稿裡有、但 v1 不做。標「Later」（目前沒有項目在這個狀態）。
 *
 * 2026-11-15 使用者決定（cre8-app#79）：這次只開純持有與定期定額；其他六種策略一律灰色「Coming soon」、不可點。
 *
 * ⚠ 開關只管「入口鎖不鎖」。`depositCard`、`depositCrossChain`、`ondoStocks`、`settingsDelay`
 * 背後的功能還沒做：把它們改成 `on` 只會拿掉灰色與標記，要等功能接上才真的能用。
 * 設計器裡本來就有的項目（策略、閒置生息、績效費）改成 `on` 就恢復原本的行為。
 */
export type FeatureState = 'on' | 'mainnet' | 'soon' | 'later';

export type Feature = {
  state: FeatureState;
  /** 給使用者看的名稱。 */
  name: string;
  /** 滑過或點擊灰色入口時顯示的那一句說明。 */
  note: string;
};

const MAINNET = 'Opens on mainnet.';
const SOON = 'Coming soon to testnet.';

export const FEATURES = {
  // ---- 入金（產品架構第 4 節） ----
  depositCard: {
    state: 'mainnet',
    name: 'Card or Apple Pay',
    note: `Buy USDT with a card or Apple Pay, sent straight to your account. ${MAINNET}`,
  },
  depositCrossChain: {
    state: 'mainnet',
    name: 'From another chain',
    note: `Bring USDC or USDT over from other chains in one step. ${MAINNET}`,
  },
  // ---- 資產（第 9 節） ----
  ondoStocks: {
    state: 'mainnet',
    name: 'More US stocks and ETFs (Ondo)',
    note: `One of hundreds more US stocks and ETFs issued by Ondo. ${MAINNET}`,
  },
  // ---- 第二批：策略與基金規則（第 7、8 節） ----
  strategyDca: {
    // 2026-11-15 使用者決定（docs#57 G0-4）：每個資產各自選純持有或定期定額，定期定額的參數（每天或每週、星期、時刻、
    // 分幾期）也逐資產由創作者設定，買的人只決定投多少。後端 BE-2（backend#93）已收這組參數，開放。
    state: 'on',
    name: 'Recurring buys',
    note: `You set daily or weekly buys for each asset, over up to a year (365 daily / 52 weekly buys). ${SOON}`,
  },
  strategyDips: {
    state: 'soon',
    name: 'Buy the dip',
    note: `Buy pullbacks and take profit on each rally. ${SOON}`,
  },
  strategyLimits: {
    state: 'soon',
    name: 'Limit, take-profit and stop-loss',
    note: `Set the prices an asset is bought and sold at. ${SOON}`,
  },
  /** 純持有期間把資產出借或質押（設計器 Buy & hold 的「While it's held」）。不是閒置 USDT 生息。 */
  holdEarn: {
    state: 'soon',
    name: 'Earn while held',
    note: `Lend or stake an asset while the fund holds it. ${SOON}`,
  },
  /** 設計器的整檔規則（再平衡、留強、配對網格、整檔停損）。閒置生息另有 `idleYield`。 */
  fundRules: {
    state: 'soon',
    name: 'Whole-fund rules',
    // 再平衡已另外開放（全部 Buy & hold 時可選每月或偏離 5 點），這裡只剩其他整檔規則。
    note: `Keep the strongest, trade a pair or stop out the whole fund. ${SOON}`,
  },
  idleYield: {
    state: 'soon',
    name: 'Earn on idle USDT',
    note: `Waiting USDT is lent out and pulled back before each buy. ${SOON}`,
  },
  performanceFee: {
    state: 'soon',
    name: 'Performance fee',
    note: `Set your own fee on holders’ realized profit. ${SOON}`,
  },
  settingsDelay: {
    state: 'soon',
    name: '24-hour notice on changes',
    note: `Changes to a fund take effect 24 hours after you publish them, so holders can leave first. ${SOON}`,
  },
  // ---- 原本標「Later」的四種策略：使用者決定一律顯示「Coming soon」（cre8-app#79） ----
  strategyRange: { state: 'soon', name: 'Range trade', note: `Buy low and sell high between two prices. ${SOON}` },
  strategyTrend: { state: 'soon', name: 'Ride the trend', note: `Buy breakouts and exit when the trend turns. ${SOON}` },
  strategyLp: { state: 'soon', name: 'Earn fees', note: `Provide liquidity in a PancakeSwap pool. ${SOON}` },
  strategyCarry: { state: 'soon', name: 'Borrow & earn', note: `Borrow against an asset and lend the proceeds. ${SOON}` },
} as const satisfies Record<string, Feature>;

export type FeatureKey = keyof typeof FEATURES;

const STATES: readonly FeatureState[] = ['on', 'mainnet', 'soon', 'later'];

/**
 * 部署時的覆寫：`VITE_FEATURES="strategyDca=on,depositCard=soon"`。
 * 不認得的名稱或狀態直接忽略（打錯字不該把某個功能意外打開）。
 */
export function parseFeatureOverrides(raw: string | undefined): Partial<Record<FeatureKey, FeatureState>> {
  const overrides: Partial<Record<FeatureKey, FeatureState>> = {};
  for (const part of (raw ?? '').split(',')) {
    const [key, state] = part.split('=').map((piece) => piece.trim());
    if (key === undefined || state === undefined) continue;
    if (!Object.hasOwn(FEATURES, key) || !STATES.includes(state as FeatureState)) continue;
    overrides[key as FeatureKey] = state as FeatureState;
  }
  return overrides;
}

const OVERRIDES = parseFeatureOverrides(import.meta.env.VITE_FEATURES);

export function featureState(key: FeatureKey, overrides: Partial<Record<FeatureKey, FeatureState>> = OVERRIDES): FeatureState {
  return overrides[key] ?? FEATURES[key].state;
}

const LABEL: Record<Exclude<FeatureState, 'on'>, string> = { mainnet: 'Mainnet', soon: 'Coming soon', later: 'Later' };

export type FeatureLockInfo = {
  feature: FeatureKey;
  state: Exclude<FeatureState, 'on'>;
  /** 標記上的短字：「Mainnet」「Coming soon」「Later」。 */
  label: string;
  name: string;
  note: string;
};

/** 這一項鎖著的話回傳要顯示的東西；可以用（`on`）回 `null`。 */
export function featureLock(key: FeatureKey, overrides?: Partial<Record<FeatureKey, FeatureState>>): FeatureLockInfo | null {
  const state = featureState(key, overrides);
  if (state === 'on') return null;
  return { feature: key, state, label: LABEL[state], name: FEATURES[key].name, note: FEATURES[key].note };
}

/** 設計器的每種策略對應哪個開關。`hold`（買進持有）一直開著，不受開關管；`stack` 跟 `strategyDca`。 */
const PLAY_FEATURE: Record<string, FeatureKey> = {
  stack: 'strategyDca',
  dips: 'strategyDips',
  custom: 'strategyLimits',
  range: 'strategyRange',
  trend: 'strategyTrend',
  lp: 'strategyLp',
  carry: 'strategyCarry',
};

export function playLock(play: string, overrides?: Partial<Record<FeatureKey, FeatureState>>): FeatureLockInfo | null {
  const feature = PLAY_FEATURE[play];
  return feature === undefined ? null : featureLock(feature, overrides);
}
