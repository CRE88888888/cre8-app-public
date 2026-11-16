/**
 * 生息（APP-3，cre8-app#81）：逐資產選市場、買家同意、停止生息並全部領回、收據估值與待領回。
 *
 * 規格：docs strategies-spec §7、research/2026-11-16-yield-markets；合約 cre8-contracts#49
 * （`AtpYieldRegistry.setYieldPolicy`／`requestExit`）；後端契約照 C3 在 backend#84 的留言：
 *   (a) 每條鏈的市場清單（市場 id、協議、資產、年化、是否模擬）
 *   (b) /execution 回每資產生息狀態、收據債權估值、待領回金額與原因、模擬利率標記
 *   (c) 買家同意生息、取消同意（只停新存入）、停止生息並全部領回
 * 後端 BE-3 已合併（backend#103，docs/yield-be84.zh-TW.md）：欄位以該文件為準，只改 `parse*` 這幾個入口。
 *
 * 決定（使用者 2026-11-16）：策略參數歸創作者，每個資產各自選市場，沒有市場的資產不能選；
 * 買家側（暫定，待使用者確認）有同意勾選（不勾該部位不存）與「停止生息並全部領回」。
 *
 * 純邏輯：不碰 React、不碰 fetch、不碰鏈。金額一律 raw 字串／BigInt。
 */
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';

export type YieldProtocol = 'venus' | 'lista' | 'aave_v3';

/** 市場清單的一筆（後端 (a)）。`id` 是平台市場 id（版本 `execution.assets[].yield.market`），`marketId` 是鏈上 bytes32。 */
export type YieldMarket = {
  id: string;
  marketId: Hex;
  protocol: YieldProtocol;
  /** 底層資產地址（小寫）。 */
  asset: string;
  symbol: string;
  /** 收據代幣（Venus vToken、Lista vault share、Aave aToken）。領回時 executor 從帳戶拉這個。 */
  receipt: string;
  /** APR（bps，不是 APY）。模擬市場是部署時設定的模擬名目年化，不是協議實際收益。null = 讀不到，畫面顯示「—」。 */
  aprBps: number | null;
  /** true = 測試網模擬市場：畫面一定要標「模擬利率」。 */
  simulated: boolean;
  /** false = 市場停止新存入（退休、暫停或讀不到）；已存的仍可領回。 */
  supplyOpen: boolean;
  /** 這筆市場資料的讀取時間（ISO）；null = 後端沒給。 */
  dataAt: string | null;
};

export type YieldMarketList = { chainId: number; registry: string; markets: YieldMarket[] };

export const PROTOCOL_NAME: Record<YieldProtocol, string> = { venus: 'Venus', lista: 'Lista', aave_v3: 'Aave' };

/** 模擬市場的標記（C3：「模擬利率」標記必須顯示）。 */
export const SIMULATED_RATE_LABEL = 'Simulated rate · 模擬利率';
export const SIMULATED_RATE_NOTE =
  'Testnet market with a simulated rate set by CRE8. It is not a real protocol yield and says nothing about mainnet returns.';

/** 平台市場 id 的格式（與 db `strategy_asset_yield_markets.market_id` 同一條）。 */
const MARKET_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const RAW = /^\d+$/;

/** `500` → `5.00% APR`；讀不到 → `APR —`（後端給的是 APR，不是 APY）。 */
export function aprText(aprBps: number | null): string {
  return aprBps === null ? 'APR —' : `${(aprBps / 100).toFixed(2)}% APR`;
}

/** 選單上的一行：`Venus · 5.00% APR`。模擬標記另外用徽章顯示，不塞在這裡。 */
export function marketLabel(market: Pick<YieldMarket, 'protocol' | 'aprBps'>): string {
  return `${PROTOCOL_NAME[market.protocol]} · ${aprText(market.aprBps)}`;
}

/**
 * 某個資產可選的市場：只列出這個資產實際有、而且還收新存入的市場（C3 第 1 點）。
 * 用地址比對；設計器的資產還沒換成這條鏈的地址時（`address` 是 null），退回比對鏈上代號。
 */
export function marketsFor(
  markets: readonly YieldMarket[],
  asset: { address: string | null; symbol: string },
): YieldMarket[] {
  const address = asset.address?.toLowerCase() ?? null;
  const symbol = asset.symbol.toUpperCase();
  return markets
    .filter((market) => market.supplyOpen && (address !== null ? market.asset === address : market.symbol.toUpperCase() === symbol))
    .sort((a, b) => (b.aprBps ?? -1) - (a.aprBps ?? -1) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------------------------
// 地址簿核對（cre8-app#95 審查第 1、2 項）
// ---------------------------------------------------------------------------------------------------------------

/** 一條鏈的生息地址簿：executor、yieldRegistry 與每個市場的固定身分（全部小寫）。來源見 `yield-book.ts`。 */
export type YieldBook = {
  chainId: number;
  executor: string;
  registry: string;
  markets: readonly { id: string; protocol: YieldProtocol; symbol: string; asset: string; receipt: string; marketId: string }[];
};

/** 後端給的生息地址與地址簿不符：停下，不拿這些地址組交易。 */
export class YieldBookMismatch extends Error {
  readonly title = 'Network setup problem';
  readonly technical: string;
  constructor(technical: string) {
    super('CRE8’s servers gave lending details that do not match this app’s address book, so nothing was sent. This is on our side. Please try again later.');
    this.name = 'YieldBookMismatch';
    this.technical = technical;
  }
}

function checkMarkets(markets: readonly YieldMarket[], book: YieldBook): void {
  for (const market of markets) {
    const known = book.markets.find((item) => item.id === market.id);
    if (known === undefined) throw new YieldBookMismatch(`market ${market.id}: not in the address book`);
    for (const field of ['protocol', 'asset', 'receipt', 'marketId'] as const) {
      if (String(market[field]).toLowerCase() !== known[field]) {
        throw new YieldBookMismatch(`market ${market.id}: ${field} is ${market[field]}, address book has ${known[field]}`);
      }
    }
  }
}

/**
 * 市場清單整份核對地址簿：鏈、yieldRegistry、每個市場的 slug／協議／資產／收據／marketId 要整組相同。
 * APR、supplyOpen 等動態資料照 API。沒有地址簿（不是 chain 97）一律不符。
 */
export function checkYieldBook(list: YieldMarketList, book: YieldBook | null): YieldMarketList {
  if (book === null) throw new YieldBookMismatch(`chain ${list.chainId}: lending is only on chain 97`);
  if (list.chainId !== book.chainId) throw new YieldBookMismatch(`chainId is ${list.chainId}, expected ${book.chainId}`);
  if (list.registry.toLowerCase() !== book.registry) throw new YieldBookMismatch(`yieldRegistry is ${list.registry}, address book has ${book.registry}`);
  checkMarkets(list.markets, book);
  return list;
}

/**
 * 帳戶狀態的每一列：資產必須就是地址簿裡那個市場的資產（複審 F1）。名稱改用地址簿的代號，不用後端給的。
 * 不符就整份丟 `YieldBookMismatch`（畫面進入讀取失敗，不能送簽）。
 */
export function checkYieldRows(value: PortfolioYield, book: YieldBook): PortfolioYield {
  return {
    ...value,
    assets: value.assets.map((row) => {
      const known = book.markets.find((item) => item.id === row.market);
      if (known === undefined) throw new YieldBookMismatch(`status row ${row.market}: not in the address book`);
      if (row.asset.toLowerCase() !== known.asset) throw new YieldBookMismatch(`status row ${row.market}: asset is ${row.asset}, address book has ${known.asset}`);
      return { ...row, asset: known.asset, symbol: known.symbol };
    }),
  };
}

/** 簽名前最後一次核對：鏈、executor、yieldRegistry、這次要簽的每個市場，以及每一列的資產與市場相符。 */
export function checkYieldSigning(
  args: { chainId: number; executor: string; registry: string; markets: readonly YieldMarket[]; rows: readonly AssetYield[] },
  book: YieldBook | null,
): void {
  if (book === null || args.chainId !== book.chainId) throw new YieldBookMismatch(`chain ${args.chainId}: lending is only on chain 97`);
  if (args.executor.toLowerCase() !== book.executor) throw new YieldBookMismatch(`executor is ${args.executor}, address book has ${book.executor}`);
  if (args.registry.toLowerCase() !== book.registry) throw new YieldBookMismatch(`yieldRegistry is ${args.registry}, address book has ${book.registry}`);
  checkMarkets(args.markets, book);
  checkYieldRows({ permission: 'unknown', accountValue: null, assets: [...args.rows] }, book);
  for (const row of args.rows) {
    if (!args.markets.some((market) => market.id === row.market && market.asset === row.asset.toLowerCase())) {
      throw new YieldBookMismatch(`status row ${row.market}: no matching market to sign`);
    }
  }
}

/** 解析市場清單；格式不對的那一筆丟掉，整份不對回 null（畫面就當沒有生息，不猜）。 */
export function parseYieldMarkets(value: unknown): YieldMarketList | null {
  if (!isRecord(value) || !Array.isArray(value.markets)) return null;
  const chainId = Number(value.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || typeof value.registry !== 'string' || !ADDRESS.test(value.registry)) return null;
  const markets: YieldMarket[] = [];
  const seen = new Set<string>();
  for (const item of value.markets) {
    if (!isRecord(item)) continue;
    const { id, marketId, protocol, asset, symbol, receipt, aprBps, simulated, supplyOpen } = item;
    if (typeof id !== 'string' || !MARKET_SLUG.test(id) || seen.has(id)) continue;
    if (typeof marketId !== 'string' || !BYTES32.test(marketId)) continue;
    if (protocol !== 'venus' && protocol !== 'lista' && protocol !== 'aave_v3') continue;
    if (typeof asset !== 'string' || !ADDRESS.test(asset) || typeof receipt !== 'string' || !ADDRESS.test(receipt)) continue;
    if (typeof symbol !== 'string' || symbol === '') continue;
    // 讀不到 APR 是 null：市場照樣列出（顯示「—」），不丟掉；其他不合法的值才丟。
    if (aprBps !== null && (typeof aprBps !== 'number' || !Number.isInteger(aprBps) || aprBps < 0)) continue;
    // 是否模擬一定要明講；`simulated` 與 `is_simulated` 都沒有就不能顯示（不然模擬利率可能被當成真的）。
    const isSimulated = typeof simulated === 'boolean' ? simulated : item.is_simulated;
    if (typeof isSimulated !== 'boolean') continue;
    seen.add(id);
    markets.push({
      id,
      marketId: marketId.toLowerCase() as Hex,
      protocol,
      asset: asset.toLowerCase(),
      symbol,
      receipt: receipt.toLowerCase(),
      aprBps,
      simulated: isSimulated,
      // 只有後端明確說 `supplyOpen: true` 才收新存入；沒給、不是布林、讀不到 APR 一律關（審查 #95 第 6 項）。
      supplyOpen: supplyOpen === true && aprBps !== null,
      dataAt: isoOrNull(item.dataAt),
    });
  }
  return { chainId, registry: value.registry.toLowerCase(), markets };
}

// ---------------------------------------------------------------------------------------------------------------
// 設計器：每個資產選的市場（存在草稿裡）
// ---------------------------------------------------------------------------------------------------------------

/** 草稿裡的欄位：設計器資產 key（現金用 `CASH_PICK`）→ 平台市場 id。沒有這個 key 就是不生息。 */
export type YieldPicks = Record<string, string>;
export const CASH_PICK = 'cash';

/** 從草稿 JSON 讀出選擇。參考設計的 `reviveBuilder` 會丟掉它不認得的欄位，所以另外從原始 JSON 讀。 */
export function readYieldPicks(raw: unknown): YieldPicks {
  if (!isRecord(raw) || !isRecord(raw.yieldPicks)) return {};
  const picks: YieldPicks = {};
  for (const [key, value] of Object.entries(raw.yieldPicks)) {
    if (typeof value === 'string' && MARKET_SLUG.test(value) && key.length > 0 && key.length <= 64) picks[key] = value;
  }
  return picks;
}

/** 換一個資產的選擇（`null` = 不生息）。回傳新的物件，不改原本的。 */
export function setYieldPick(picks: YieldPicks, key: string, market: string | null): YieldPicks {
  const next = { ...picks };
  if (market === null) delete next[key];
  else next[key] = market;
  return next;
}

/** 只留下設計裡還有的資產（刪掉資產時一起刪它的選擇；現金一直都在）。 */
export function prunePicks(picks: YieldPicks, keys: readonly string[]): YieldPicks {
  const keep = new Set([...keys, CASH_PICK]);
  return Object.fromEntries(Object.entries(picks).filter(([key]) => keep.has(key)));
}

/** 側欄「Lending income」：逐資產選了哪個市場（模擬利率不當估算）。沒選回 null；找不到市場寫 unknown。 */
export function lendingChoicesText(entries: readonly { name: string; market: YieldMarket | null | undefined }[]): string | null {
  if (entries.length === 0) return null;
  return entries.map(({ name, market }) => `${name} on ${market ? PROTOCOL_NAME[market.protocol] : 'unknown'}`).join(' · ');
}

/** 「Lend the cash」的選項：Off ＋ 開放中的市場；已選但已關閉的市場也列出來，才能看見並改成 Off（審查第 9 項）。 */
export function cashLendingOptions(open: readonly YieldMarket[], current: string | null): [string, string][] {
  const options: [string, string][] = [['', 'Off'], ...open.map((market): [string, string] => [market.id, marketLabel(market)])];
  if (current !== null && !open.some((market) => market.id === current)) options.push([current, `Closed market (${current})`]);
  return options;
}

/**
 * 建立頁：草稿有生息選擇時，市場清單要先成功讀到才能建立（審查第 6 項）。
 * 回 `loading`／`error` 就擋住；沒選擇、或清單已讀到（含這條鏈沒有生息的 null）回 null。
 */
export function yieldListBlock(pickCount: number, list: { data: YieldMarketList | null | undefined; isError: boolean }): 'loading' | 'error' | null {
  if (pickCount === 0) return null;
  if (list.isError) return 'error';
  if (list.data === undefined) return 'loading';
  return null;
}

/**
 * 選的市場還能不能用：清單裡沒有、或不是這個資產的市場（例如舊草稿、清單更新後）。
 * 回傳有問題的資產名稱；設計器與建立頁擋住啟用、請創作者重選。
 */
export function stalePicks(
  picks: YieldPicks,
  assets: readonly { key: string; name: string; address: string | null; symbol: string }[],
  markets: readonly YieldMarket[],
): string[] {
  const names: string[] = [];
  for (const asset of assets) {
    const pick = picks[asset.key];
    if (pick === undefined) continue;
    if (!marketsFor(markets, asset).some((market) => market.id === pick)) names.push(asset.name);
  }
  return names;
}

// ---------------------------------------------------------------------------------------------------------------
// 持有人：每資產生息狀態（後端 (b)）
// ---------------------------------------------------------------------------------------------------------------

/**
 * - `not_consented`：基金有選市場，但這個帳戶還沒同意：這個部位維持持有，不存。
 * - `cash`：同意了，還沒存（等待下一次存入條件；利率跳動時合約只暫停新存入，不擋領出）。
 * - `supplied`：已存入，持有收據。部分領出之後仍是這個狀態，之後還可以再存（cre8-contracts#49 修正後的行為）。
 * - `exiting`：全部領回、不再存入。只有風險標記會進來：使用率 ≥90%、資料失效、或自己按「停止生息並全部領回」。
 * - `stopped`：同意已撤回而且收據歸零。
 *
 * 取消同意（revoke）之後若收據還在，後端仍回 `supplied`；要靠 `consented`（backend#105）分出「已取消同意、仍在出借」。
 */
export type AssetYieldState = 'not_consented' | 'cash' | 'supplied' | 'exiting' | 'stopped';

/** 待領回的原因（後端 (b)）。認不出來的一律當 `unknown`，畫面照實說「原因不明」，不猜。 */
export type PendingReason = 'market_paused' | 'high_utilization' | 'low_liquidity' | 'unknown';

export type AssetYield = {
  asset: string;
  symbol: string;
  /** 平台市場 id。 */
  market: string;
  state: AssetYieldState;
  /** 收據對應的保守 USDT 債權（raw，USDT decimals）。null = 讀不到（不是 0）。 */
  receiptValue: string | null;
  /** 領不出來的部分。null = 沒有待領回。 */
  pending: { value: string | null; reason: PendingReason } | null;
  /** 這筆資料的讀取時間（ISO）；null = 後端沒給。 */
  dataAt: string | null;
  /** 保守債權（底層資產 raw）。null = 讀不到。 */
  claimAssets: string | null;
  /** 目前市場最多能領回多少（底層資產 raw）。null = 讀不到。 */
  maxWithdraw: string | null;
  /** 估值是否可信：`unknown` 時金額一律不可當真。後端沒給或認不出來回 null。 */
  valuationState: 'known' | 'unknown' | null;
  /** 本人在目前 enrollment 下的同意是否有效（backend#105）。revoke 或 exit 之後為 false。後端沒給：null，照舊行為。 */
  consented: boolean | null;
};

/** 帳戶的生息權限：舊 session 沒有生息 selector，要 owner 重新授權（BE-4）。 */
export type YieldPermission = 'ok' | 'needs_update' | 'unknown';

export type PortfolioYield = {
  permission: YieldPermission;
  /** 帳戶價值（含收據債權，USDT raw 字串）。null = 不知道（顯示 unknown，不顯示 0）。 */
  accountValue: string | null;
  assets: AssetYield[];
};

const STATES: readonly AssetYieldState[] = ['not_consented', 'cash', 'supplied', 'exiting', 'stopped'];
const REASONS: readonly PendingReason[] = ['market_paused', 'high_utilization', 'low_liquidity', 'unknown'];

/** 生息狀態有一列格式不對：整份當讀取失敗，不留下部分清單讓人簽（審查 #95 第 6 項）。 */
export class YieldStateInvalidError extends Error {
  constructor() {
    super('The lending status came back in an unexpected shape, so nothing can be signed. Try again later.');
    this.name = 'YieldStateInvalidError';
  }
}

/**
 * 從 `GET /portfolios/:id/execution` 的 `yield` 讀出生息狀態。沒有這個欄位（後端還沒做、或基金沒選市場）回 null。
 * 任何一列格式不對就丟 `YieldStateInvalidError`（整份進 error），不悄悄丟掉那一列：丟掉退出中的那列會讓其他市場的同意檢查誤過。
 */
export function parsePortfolioYield(value: unknown): PortfolioYield | null {
  if (!isRecord(value) || !Array.isArray(value.assets)) return null;
  const permission: YieldPermission = value.permission === 'ok' || value.permission === 'needs_update' ? value.permission : 'unknown';
  const assets: AssetYield[] = [];
  for (const item of value.assets) {
    if (!isRecord(item)) throw new YieldStateInvalidError();
    const { asset, symbol, market, state } = item;
    if (typeof asset !== 'string' || !ADDRESS.test(asset) || typeof market !== 'string' || !MARKET_SLUG.test(market)) throw new YieldStateInvalidError();
    if (typeof state !== 'string' || !STATES.includes(state as AssetYieldState)) throw new YieldStateInvalidError();
    let pending: AssetYield['pending'] = null;
    if (isRecord(item.pending)) {
      const reason = REASONS.includes(item.pending.reason as PendingReason) ? (item.pending.reason as PendingReason) : 'unknown';
      pending = { value: rawOrNull(item.pending.value), reason };
    }
    assets.push({
      asset: asset.toLowerCase(),
      symbol: typeof symbol === 'string' && symbol !== '' ? symbol : asset.slice(0, 8),
      market,
      state: state as AssetYieldState,
      receiptValue: rawOrNull(item.receiptValue),
      pending,
      dataAt: isoOrNull(item.dataAt),
      claimAssets: rawOrNull(item.claimAssets),
      maxWithdraw: rawOrNull(item.maxWithdraw),
      valuationState: item.valuationState === 'known' || item.valuationState === 'unknown' ? item.valuationState : null,
      consented: typeof item.consented === 'boolean' ? item.consented : null,
    });
  }
  return { permission, accountValue: rawOrNull(value.accountValue), assets };
}

/** 已取消同意、但收據還在（backend#105 `consented: false`）：不再新存入，已借出的照樣估值，要拿回請全部領回。 */
export function cancelledButLent(row: AssetYield): boolean {
  return row.consented === false && row.state === 'supplied';
}

export const CANCELLED_LENT_LABEL = {
  label: 'Consent cancelled · still lent',
  note: 'Nothing new is lent. What is already lent stays lent and is still valued here; to get it back, use Stop lending and withdraw everything.',
} as const;

/** 每個狀態的徽章與一句說明（`note` 為 null 就不另外說明）。 */
export const STATE_LABEL: Record<AssetYieldState, { label: string; tone: 'ok' | 'warn' | 'neutral'; note: string | null }> = {
  not_consented: { label: 'Not lent', tone: 'neutral', note: null },
  cash: {
    label: 'Waiting to lend',
    tone: 'neutral',
    note: 'Lent at the next lending window, once the market is taking new deposits. A paused market only holds back new lending; it does not stop withdrawals.',
  },
  supplied: { label: 'Lent', tone: 'ok', note: null },
  exiting: {
    label: 'Withdrawing all',
    tone: 'warn',
    note: 'Everything lent is coming back, and nothing new is lent until it all has. This happens when you stop lending, or when the market looks risky (90% or more of it lent out, or its data could not be checked).',
  },
  stopped: { label: 'Stopped', tone: 'neutral', note: null },
};

/** 待領回的原因，白話。 */
export function pendingReasonText(reason: PendingReason): string {
  switch (reason) {
    case 'market_paused':
      return 'The market has paused withdrawals.';
    case 'high_utilization':
      return 'Most of the market is lent out right now, so there is not enough cash to pay it back yet.';
    case 'low_liquidity':
      return 'The market does not have enough cash to pay it back yet.';
    case 'unknown':
      return 'The reason could not be read.';
  }
}

/**
 * 全部領回是整個帳戶的意圖（backend#103）：任何一個市場還在 `exiting`，就還沒完成，後端不收新的同意（409 YIELD_EXIT_PENDING）。
 * 畫面在簽名前就要擋，不能讓人簽了鏈上同意才被後端拒絕。
 */
export function exitInProgress(assets: readonly AssetYield[]): boolean {
  return assets.some((row) => row.state === 'exiting');
}

/**
 * 還沒同意、可以勾選的資產（市場還收新存入）。全部領回還沒完成時一個都不行。
 * 已出借但取消了同意（`supplied` ＋ `consented: false`）可以直接重新同意（審查第 10 項）。
 */
export function consentable(assets: readonly AssetYield[], markets: readonly YieldMarket[]): AssetYield[] {
  if (exitInProgress(assets)) return [];
  return assets.filter((row) => {
    if (row.state !== 'not_consented' && row.state !== 'stopped' && !cancelledButLent(row)) return false;
    const market = markets.find((item) => item.id === row.market);
    return market !== undefined && market.supplyOpen;
  });
}

/**
 * 可以取消同意的資產：已同意、還沒全部領回中的（`cash`、`supplied`）。
 * 取消同意只停新存入，已存的照樣估值、不領回；全部領回進行中時取消沒有意義，不列。
 */
export function revocable(assets: readonly AssetYield[]): AssetYield[] {
  if (exitInProgress(assets)) return [];
  return assets.filter((row) => (row.state === 'cash' || row.state === 'supplied') && row.consented !== false);
}

/** 停止生息會影響哪些市場：已同意、已存、或正在領回的（重按一次「停止」也要能再送）。 */
export function stoppable(assets: readonly AssetYield[]): AssetYield[] {
  return assets.filter((row) => row.state === 'cash' || row.state === 'supplied' || row.state === 'exiting');
}

/**
 * Lending 區塊的狀態（審查第 7 項）：
 * - `off`：這條鏈沒有生息、或這檔基金沒選市場 → 不顯示。
 * - `loading`：還在讀。
 * - `error`：市場清單或帳戶狀態讀不到（含有舊快取但重抓失敗）→ 金額寫 unknown、給重試，不能送簽。
 * - `ready`：可以顯示、可以送簽。
 */
export type YieldViewState = 'off' | 'loading' | 'error' | 'ready';

export function yieldViewState(input: {
  chainHasYield: boolean;
  markets: { data: YieldMarketList | null | undefined; isError: boolean; isPending: boolean };
  status: { data: PortfolioYield | null | undefined; isError: boolean; isPending: boolean };
}): YieldViewState {
  if (!input.chainHasYield) return 'off';
  if (input.markets.isError) return 'error';
  if (input.markets.data === null) return 'off';
  if (input.markets.data === undefined) return 'loading';
  if (input.status.isError) return 'error';
  if (input.status.data === undefined) return 'loading';
  if (input.status.data === null || input.status.data.assets.length === 0) return 'off';
  return 'ready';
}

/** 全部領回進行中：每 30 秒重讀，完成後畫面自己更新（審查第 8 項）。 */
export function yieldRefreshMs(data: PortfolioYield | null | undefined): number | false {
  return data !== null && data !== undefined && exitInProgress(data.assets) ? 30_000 : false;
}

/** 送簽前重讀的狀態跟畫面上的不一樣了（例如另一個分頁開始全部領回）。 */
export class YieldStateChanged extends Error {
  constructor() {
    super('Lending status changed since this page loaded. Check the updated status and try again.');
    this.name = 'YieldStateChanged';
  }
}

/**
 * 送簽前用剛重讀的狀態重新決定要簽哪些市場（審查第 8 項）。
 * consent／revoke：畫面上選的每一個都要仍然可以做，否則整個停下；exit：用最新的可停止清單。
 */
export function recheckBeforeSigning(
  kind: 'consent' | 'revoke' | 'exit',
  wanted: readonly string[],
  fresh: PortfolioYield | null,
  markets: readonly YieldMarket[],
): AssetYield[] {
  if (fresh === null) throw new YieldStateChanged();
  if (kind === 'exit') {
    const rows = stoppable(fresh.assets);
    if (rows.length === 0) throw new YieldStateChanged();
    return rows;
  }
  const allowed = kind === 'consent' ? consentable(fresh.assets, markets) : revocable(fresh.assets);
  const rows = wanted.map((market) => allowed.find((row) => row.market === market));
  if (rows.length === 0 || rows.some((row) => row === undefined)) throw new YieldStateChanged();
  return rows as AssetYield[];
}

/** 每次簽名最多幾個市場：同意每個市場 2 筆 call，paymaster 一個 UserOp 最多 32 筆（審查第 4 項）。 */
export const YIELD_BATCH_MARKETS = 16;

export function yieldBatches<T>(items: readonly T[], size = YIELD_BATCH_MARKETS): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size));
  return batches;
}

// ---------------------------------------------------------------------------------------------------------------
// owner 要簽的 calls（cre8-contracts#49）
// ---------------------------------------------------------------------------------------------------------------

export const YIELD_REGISTRY_ABI = parseAbi([
  'function setYieldPolicy(bytes32 marketId, uint256 dailyAssets, bool enabled)',
  'function requestExit(bytes32 marketId)',
]);

export type YieldCall = { to: Address; data: Hex; value: bigint };

/**
 * 同意時寫進鏈上的每日存入上限：`type(uint256).max`，也就是不另設每日金額上限（C3 2026-11-16 決定）。
 * 這是技術安全參數，買家看不到、也不由後端給。實際曝險已經由合約擋住：每帳戶每個資產 24 小時只能存一次、
 * 單筆至少 50 USDT 等值、全平台在該市場的曝險不超過 min(S/100, L/10)。合約只拒絕 0（ConsentRequired）。
 */
export const CONSENT_DAILY_ASSETS = maxUint256;

/**
 * 同意生息：每個市場兩筆，同一個 UserOp。
 * 1. 收據 `approve(executor, max)`：領回時 executor 從帳戶拉收據去贖回（存入用的底層資產授權在買入時已經給過）。
 * 2. `registry.setYieldPolicy(marketId, CONSENT_DAILY_ASSETS, true)`：只有帳戶自己能同意，綁定當下的策略與版本。
 */
export function consentCalls(args: {
  registry: string;
  executor: string;
  markets: readonly YieldMarket[];
}): YieldCall[] {
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [args.executor as Address, maxUint256] });
  return args.markets.flatMap((market) => [
    { to: market.receipt as Address, data: approve, value: 0n },
    {
      to: args.registry as Address,
      data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'setYieldPolicy', args: [market.marketId, CONSENT_DAILY_ASSETS, true] }),
      value: 0n,
    },
  ]);
}

/**
 * 取消同意：每個市場一筆 `setYieldPolicy(marketId, 0, false)`。只停新存入，不領回（全部領回走 `exitCalls`）。
 * 合約只在 `enabled` 為 true 時拒絕 0，所以取消時帶 0。
 */
export function revokeCalls(args: { registry: string; markets: readonly YieldMarket[] }): YieldCall[] {
  return args.markets.map((market) => ({
    to: args.registry as Address,
    data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'setYieldPolicy', args: [market.marketId, 0n, false] }),
    value: 0n,
  }));
}

/** 停止生息：每個市場一筆 `requestExit`。停止新存入並進入退出；領回由後端用 session 的 exit 路徑送。 */
export function exitCalls(args: { registry: string; markets: readonly YieldMarket[] }): YieldCall[] {
  return args.markets.map((market) => ({
    to: args.registry as Address,
    data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'requestExit', args: [market.marketId] }),
    value: 0n,
  }));
}

/** 停止後的一句話：有領不出的部分要講出來。 */
export function exitDoneMessage(pendingCount: number): string {
  return pendingCount === 0
    ? 'Lending is stopped. Everything lent is being withdrawn back to this account.'
    : 'Lending is stopped. What the markets can pay back is being withdrawn now; the rest stays listed as waiting to come back until they can.';
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function rawOrNull(value: unknown): string | null {
  return typeof value === 'string' && RAW.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
