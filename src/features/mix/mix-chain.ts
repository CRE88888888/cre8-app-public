/**
 * My mix 的鏈上步驟（cre8-app#132）：簽後端準備好的 owner UserOp、確認、把 USDT 放進組合帳戶並記成入金、領回 USDT。
 *
 * 簽名：`POST /me/mixes`（或 PATCH 改成分）回 `calls`（必要的新資產 approve＋最後一筆 enroll）與完整 `nonce`。
 * App 照原樣用帳戶 owner 簽一個 sudo UserOp（經既有 sponsor 與 `POST /bundler`），nonce 用後端給的。
 * 簽之前把每一筆 calldata 解碼核對（C3 審查 #133 第 4 點）：
 * - 前面只能是 `approve(executor, max)`，目標是目錄裡的資產或 USDT；
 * - 接著是 registry 的 `enroll(payload.account, id, 1)`，而且鏈上這個 id 的第 1 版就是用戶挑的資產與比例；
 * - 加息策略開著時改比例，enroll 後面接重新同意（backend `consentCalls`，重新 enroll 會讓舊同意失效）：
 *   只能是 Venus／Lista 委託給 AtpBorrowExecutor、開啟且上限 > 0 的 `setBorrowPolicy`、對 AtpBorrowExecutor 的全額核准
 *   （有借款市場的資產、USDT、策略 vault），絕不給 AtpExecutor；
 * - 帳戶在加息策略路由 v2 時，重新同意是 v2 的呼叫（backend `v2ReconsentCalls`）。v2 的地址不在 App 裡，由後端在簽名資料
 *   宣告（`strategyV2: { registry, executor }`），App 仍自己核對形狀與參數，並在鏈上核對那兩個地址（見 `checkStrategyConsentV2`、
 *   `assertStrategyV2`）；
 * - 路由 v2 的補差額合約 AtpBorrowCashSwapper：後端多宣告 `strategyV2.cashSwapper` 時，重新同意可以帶「USDT 與借款幣對它的全額核准」。
 *   它的地址依 chainId 釘在 App 裡（`CASH_SWAPPER`），宣告的不是釘住的那個、或這條鏈沒有釘，就不簽；給 swapper 本身的呼叫一律不簽；
 * - 其他函式一律不簽。
 * 不重組 calls——sponsor 只代付後端存下的那一組。上鏈後 `POST /me/mixes/:id/confirm`；確認不到也沒關係，
 * 後端的排程與明細查詢會自己找 Enrolled 對帳。
 *
 * 入金（審查第 1 點）：USDT 進帳戶之後，一定要 `POST /portfolios/:portfolioId/funding-lots` 記成這個組合的投入，
 * 後端才會買（排程要求可用現金＝鏈上 USDT，否則 MIX_CASH_RECONCILIATION 不買）。記帳失敗的來源存在 localStorage，
 * 組合頁打開時補記，不會因為重按 Add money 而多轉一次錢。
 */
import { useQuery } from '@tanstack/react-query';
import { createWalletClient, custom, decodeFunctionData, encodeFunctionData, erc20Abi, http, maxUint256, type Address, type Hex } from 'viem';
import { ApiError, postFaucetUsdt, postFundingLot, postGasFaucet } from '../../lib/api';
import { REGISTRY_ABI } from '../../lib/atp-contracts';
import { faucetFailure } from '../../lib/faucet';
import { waitForAccountCode } from '../../lib/first-enroll';
import { CHAIN, assertRpcChain, bsc as appChain, publicClientFor, readOnlyClient, readRpcUrl, sendSudoCalls, sendWithdraw, transferCalldata, type RenewalWallet } from '../../lib/kernel';
import { ensureOwnerGas } from '../../lib/testnet-wallet-buy';
import { TESTNET_97 } from '../../lib/testnet-97';
import { MIX_CATALOG } from './mix-catalog';
import { mixApi } from './mix-api';
import type { MixAsset, MixSigningPayload } from './mix-types';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const ERC20_BALANCE = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const lower = (value: string) => value.toLowerCase();

/** 後端回的簽名資料不對：不簽、不送。 */
export class MixPayloadError extends Error {
  readonly code = 'MIX_PAYLOAD_INVALID';
  constructor(readonly field: string) {
    super(`signing payload: ${field}`);
    this.name = 'MixPayloadError';
  }
}

/**
 * 核對 calls 用的地址：registry、executor，以及可以 approve 的資產。
 * 資產＝測試網地址簿的全部代幣（後端 My mix 收的 103 個都在裡面）＋目錄 40 個＋USDT。
 * 只認目錄 40 個時，選了目錄外的資產（例如 AMD）後端照樣建好，App 卻在簽名前擋下，一直顯示「組合沒建好」。
 */
export type MixCallBook = { registry: string; executor: string; assets: Set<string>; strategy?: MixStrategyBook; cashSwapper?: MixCashSwapperBook };
/** 路由 v2 的補差額合約（這條鏈釘住的地址），以及可以核准給它的代幣：USDT 與借款幣。全部小寫。 */
export type MixCashSwapperBook = { address: string; tokens: Set<string> };
/** 加息策略（chain 97）同意用的地址：AtpBorrowExecutor、AtpBorrowRegistry、Venus comptroller、Lista Moolah、策略 vault，以及可抵押資產（市場 id → 代幣）。 */
export type MixStrategyBook = { executor: string; registry: string; venus: string; lista: string; vault: string; usdt: string;
  markets: ReadonlyMap<string, { token: string; protocol: 'venus' | 'lista' }> };

/**
 * backend `src/strategy-earn-guard.ts` 的 `STRATEGY_EARN_97`（cre8-contracts#65/#67 `deployments/testnet-97.json` 的 `borrow`）：
 * 31 個有借款市場的資產，槓桿類不在內。只用來核對簽名資料，不用來組 call。
 */
const STRATEGY_EARN_97 = {
  executor: '0x16ab59a8bacb578c6437528ac0961e234e4b717b', registry: '0x973341a0ba6a725630f2a4f66d7dbba92fea4e00',
  venus: '0x93ab77260c8c62b26698bbb0ee8da3e175b9ad8d', lista: '0x993237ac050512f3749bfee2de759b6b86aea653', vault: '0x2e915b874a5a544736f5afd97f3fa1dd45d417a9',
  markets: [
    ['NVDAB', '0xfa06dd03eff35e3337a8b5b93a8a7943155b4f20e4d19bb0583db20bdd9f5415', 'venus'], ['TSLAB', '0x00f2152bbbefde7b3e65c4b7de0af83a87875c02b6c84ef96410ac14edd850fe', 'venus'],
    ['SPCXB', '0x4632539a0ba6e5e9843b401d97b66b8b34d23fdab2005feacefd5452055c410e', 'venus'], ['QQQB', '0xd8def95e75d2489c340ac4d9769646707cf55d17d7aa7f8644c89b64b41844e7', 'lista'],
    ['MSTRB', '0x208d888e7c3d5ef4d9ccc51083daffe7ddfbce978d339ce258544022cfd9804a', 'lista'], ['BTCB', '0x8d48b0483eb33d02f26569ab02c254eac8ac10be954fdbb157243bd09e85d2fb', 'lista'],
    ['WBNB', '0x88ca3237e09f509dd0919d6fb3c3acc3e481a174ab584dc1166db05e13addd1b', 'lista'], ['SPYB', '0x51b9790c89e3f45fd09429a276cc3993d150efbd931929a2efb5246ff5b2dbea', 'lista'],
    ['EWYB', '0xf18d92ea0ab3910af1b41c7fa590e1782c3c360272885c8654c5553ae1b5aec0', 'lista'], ['XAUt', '0xdc90c169476591d0bdaf94c8604483851a71f6f968cc6e715caaa44bc5343ddf', 'lista'],
    ['AAPLB', '0x5d49d81cb9a6ad5100cc45fea95acba206f8c2d430de244b56bd1b37c26052dc', 'lista'], ['MSFTB', '0x0011e09537679494eab5cf79e82e709c512444aace283a42af962de31caa9d6d', 'lista'],
    ['GOOGLB', '0x689d5419e2cfe939bd0eeca62624dba7d1169bf119071f6b5692af3373ecee86', 'lista'], ['AMZNB', '0xcb0b5108bfac66dc1b0ceb41dff04d840999a64a65557be8cffdf220c5a7c638', 'lista'],
    ['METAB', '0x46b15315b0d7a132ab8c1d3951dc129924f35a65cc6d362fd916ea043efc967e', 'lista'], ['TSMB', '0x4089dd869febe66e083235a22ddc27aa974608c37706e09b7c9f58d886309207', 'lista'],
    ['AVGOB', '0x22e0e2119c0a4fbc0c511fb32e9119935da28f53891d72a7b2e42ed0a19c8acb', 'lista'], ['NFLXB', '0x45a53fd0ab814504600a9d3e853a5c00fb37ca236e0dcaeb228999a0647763a9', 'lista'],
    ['INTCB', '0x7ef21622fbb4199611e5c89b5c9c7f1aba3e007f69cee91dd93d877d04a16a6e', 'lista'], ['SKHYB', '0xdfd536b4566dabdece5a60e14d8767f609ed2c12b718495336de4502e30ddf21', 'lista'],
    ['MUB', '0x8e55d0583de7b419e1d6bd4f862a23e415f13390f8f422cef7d5869380882cb9', 'lista'], ['SNDKB', '0x26a12b6c8cb5088c7b1a7565a305d615b4a10a6f7b14dc7292f9b66d1f4573a5', 'lista'],
    ['ANTB', '0x17cf8ebc51ff714d19d45dc586262ae95acfa859bfbe66936917421aef9f1ccc', 'lista'], ['BABAB', '0x0d94a872df3df2ed65010cdef0fff4b52be888a41879252f5422b51dcf849600', 'lista'],
    ['PDDB', '0xe387a4f77009e8b616e63fa02da3b600104bd4bb57f8cabad624622dea78a287', 'lista'], ['CRCLB', '0x41fe2e63f5c26f448cd67dd3b651304c6fbc36345b4ead814d76ce76f51d3fe7', 'lista'],
    ['HOODB', '0xc917a20897841a10d848200e0aab4696ba797b43b8d32ca25635ff373bdbb870', 'lista'], ['GMEB', '0xb4d9a1acb4b5cfe346b540b2aaa901c25ded7bd33d376a1721c259e13f217728', 'lista'],
    ['COINB', '0x656cf332a101a485a7e87d5877f92c555edc4929568aad341900b2ae633ca6c9', 'lista'], ['BMNRB', '0x2dd522761a2d39270426cd13075002b480bfcb137442a9b261762620e6b6148b', 'lista'],
    ['BNCB', '0xf0a9425ffd3c0b4f472854252db963cd714ae711c2ceeb84647f1bbd444e5283', 'lista'],
  ] as const,
} as const;

/**
 * 路由 v2 的補差額合約 AtpBorrowCashSwapper（規格 §17）：帳戶的 USDT 換成它欠的借款幣補進策略盒（`topUp`）、結清後換回 USDT（`cashOut`）。
 * 地址依 chainId 釘在這裡（cre8-contracts `deployments/testnet-97.borrowV2.json` 的 `cashSwapper.address` 與 `loanTokens`），不採信後端宣告的地址：
 * 後端宣告的 `strategyV2.cashSwapper` 必須就是這裡的地址。這條鏈沒有釘（主網還沒部署）就不簽任何跟 swapper 有關的呼叫。
 * `loanTokens`：USDT 以外的借款幣（USDC、USD1、U）；USDT 用 App 自己的地址簿。換了 v2 合約組就有新的 swapper，要改這裡。
 */
const CASH_SWAPPER: Readonly<Record<number, { address: string; loanTokens: readonly string[] }>> = {
  97: { address: '0x99811a1115b36f8310deadada818cae685360798',
    loanTokens: ['0xb887ca3379dc41f1155dd0cb1b2e3c1d85d17ed5', '0xea13862cb4612d228ba89b4319feec60f05ab3ac', '0xc71e4efb5a36bd54ad8de9e9742bfa8fbd750875'] },
};

export function mixCallBook(): MixCallBook {
  const contracts = CHAIN.contracts;
  const testnet = CHAIN.id === TESTNET_97.chainId;
  const book = testnet ? Object.values(TESTNET_97.assets as Record<string, string>) : [];
  const tokens = TESTNET_97.assets as Record<string, string | undefined>;
  const S = STRATEGY_EARN_97, swapper = CASH_SWAPPER[CHAIN.id];
  return {
    registry: lower(contracts?.registry ?? ''),
    executor: lower(contracts?.executor ?? ''),
    assets: new Set([...(contracts === null ? [] : [contracts.usdt]), ...book, ...MIX_CATALOG.map((asset) => asset.address)].map(lower)),
    ...(testnet && contracts !== null ? { strategy: { executor: S.executor, registry: S.registry, venus: S.venus, lista: S.lista, vault: S.vault, usdt: lower(contracts.usdt),
      markets: new Map(S.markets.flatMap(([symbol, id, protocol]) => tokens[symbol] ? [[id, { token: lower(tokens[symbol] as string), protocol }] as const] : [])) } } : {}),
    ...(swapper !== undefined && contracts !== null ? { cashSwapper: { address: swapper.address, tokens: new Set([lower(contracts.usdt), ...swapper.loanTokens]) } } : {}),
  };
}

const STRATEGY_CONSENT_ABI = [
  { type: 'function', name: 'updateDelegate', stateMutability: 'nonpayable', inputs: [{ name: 'delegate', type: 'address' }, { name: 'allowBorrows', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'setAuthorization', stateMutability: 'nonpayable', inputs: [{ name: 'authorized', type: 'address' }, { name: 'newIsAuthorized', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'setBorrowPolicy', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'maxDebt', type: 'uint256' }, { name: 'enabled', type: 'bool' }], outputs: [] },
] as const;

/** enroll 之後的加息策略重新同意：每一筆只能是下面幾種之一，而且同一筆不重複；有上限的資產一定也有核准。 */
function checkStrategyConsent(calls: readonly { to: string; data: Hex }[], book: MixCallBook): void {
  if (calls.length === 0) return;
  const s = book.strategy;
  if (s === undefined) throw new MixPayloadError('consent.chain');
  const seen = new Set<string>(), ceilings = new Set<string>(), approved = new Set<string>(), protocols = new Set<string>();
  const once = (key: string) => { if (seen.has(key)) throw new MixPayloadError('consent.duplicate'); seen.add(key); };
  for (const c of calls) {
    const to = lower(c.to);
    if (to === s.venus || to === s.lista) {
      const d = decodeOrNull(STRATEGY_CONSENT_ABI, c.data);
      const [delegate, allow] = (d?.args ?? []) as readonly [string, boolean];
      if (d?.functionName !== (to === s.venus ? 'updateDelegate' : 'setAuthorization') || lower(delegate) !== s.executor || allow !== true) throw new MixPayloadError('consent.delegate');
      once(to);
    } else if (to === s.registry) {
      const d = decodeOrNull(STRATEGY_CONSENT_ABI, c.data);
      if (d?.functionName !== 'setBorrowPolicy') throw new MixPayloadError('consent.function');
      const [id, maxDebt, enabled] = d.args as readonly [Hex, bigint, boolean];
      const market = s.markets.get(lower(id));
      if (!market || maxDebt <= 0n || enabled !== true) throw new MixPayloadError('consent.policy');
      once('policy:' + lower(id)); ceilings.add(market.token); protocols.add(market.protocol);
    } else {
      const d = decodeOrNull(erc20Abi, c.data);
      if (d?.functionName !== 'approve') throw new MixPayloadError('consent.to');
      const [spender, amount] = d.args as readonly [string, bigint];
      if (lower(spender) !== s.executor || amount !== maxUint256) throw new MixPayloadError('consent.spender');
      if (to !== s.usdt && to !== s.vault && ![...s.markets.values()].some((m) => m.token === to)) throw new MixPayloadError('consent.asset');
      once('approve:' + to);
      if (to !== s.usdt && to !== s.vault) approved.add(to);
    }
  }
  if (ceilings.size === 0 || [...ceilings].some((t) => !approved.has(t)) || [...approved].some((t) => !ceilings.has(t)) ||
      !seen.has('approve:' + s.usdt) || !seen.has('approve:' + s.vault) || [...protocols].some((p) => !seen.has(p === 'venus' ? s.venus : s.lista))) {
    throw new MixPayloadError('consent.incomplete');
  }
}

/**
 * 路由 v2 的地址（小寫）：後端在簽名資料裡宣告的 registry 與 executor；`venus`／`lista` 是這次 calls 裡委託的借貸場所；
 * `cashSwapper`：這次 calls 裡有核准給補差額合約（已經是 App 釘住的那個地址）。
 */
export type CheckedStrategyV2 = { registry: string; executor: string; venus?: string; lista?: string; cashSwapper?: string };

const STRATEGY_V2_ABI = [
  { type: 'function', name: 'setStrategyPolicy', stateMutability: 'nonpayable', inputs: [{ name: 'maxDebt', type: 'uint256' }, { name: 'rewardRecipient', type: 'address' }, { name: 'enabled', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'executor', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'venusComptroller', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'moolah', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
/** AtpBorrowCashSwapper 自己說的綁定：路由 v2 的 executor、registry，以及它用的 USDT。 */
const CASH_SWAPPER_ABI = [
  { type: 'function', name: 'executor', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'borrowRegistry', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'usdt', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/**
 * 路由 v2 的重新同意（backend `v2ReconsentCalls`／`v2ConsentCalls`）。地址是後端宣告的，所以這裡只認三種呼叫，其他一律不簽：
 * - 宣告的 registry 上一筆 `setStrategyPolicy(上限 > 0, 獎勵收款人＝這個錢包, true)`，剛好一筆；
 * - 地址簿裡的資產對宣告的 executor 的全額核准（不重複）；
 * - 借貸場所的委託 `updateDelegate(executor, true)`／`setAuthorization(executor, true)`，各最多一筆。
 * 後端另外宣告了 `cashSwapper`、而且它就是 App 在這條鏈釘住的補差額合約（`book.cashSwapper`）時，再多認一種：
 * - USDT 或借款幣對它的全額核准（不重複）。別的代幣、沒宣告、宣告的不是釘住的那個、這條鏈沒有釘：不簽。
 * 給 swapper 本身的呼叫（`topUp`、`cashOut`、`setPool`…）不屬於改比例，一律不簽。
 * 宣告的地址本身、委託的場所、swapper 的綁定，簽名前再由 `assertStrategyV2` 在鏈上核對。v1 與 v2 的呼叫不能混在同一組。
 */
function checkStrategyConsentV2(calls: readonly { to: string; data: Hex }[], book: MixCallBook, v2: DeclaredStrategyV2, owner: string | undefined): CheckedStrategyV2 {
  if (owner === undefined || !ADDRESS.test(owner)) throw new MixPayloadError('consent.owner');
  const pin = book.cashSwapper, swapper = pin !== undefined && v2.cashSwapper === pin.address ? pin : undefined;
  const isSwapper = (address: string) => address === v2.cashSwapper || address === pin?.address;
  const seen = new Set<string>(), out: CheckedStrategyV2 = { registry: v2.registry, executor: v2.executor };
  const once = (key: string) => { if (seen.has(key)) throw new MixPayloadError('consent.duplicate'); seen.add(key); };
  for (const c of calls) {
    const to = lower(c.to);
    if (isSwapper(to)) throw new MixPayloadError('consent.swapper');
    if (to === v2.registry) {
      const d = decodeOrNull(STRATEGY_V2_ABI, c.data);
      if (d?.functionName !== 'setStrategyPolicy') throw new MixPayloadError('consent.function');
      const [maxDebt, recipient, enabled] = d.args as readonly [bigint, string, boolean];
      if (maxDebt <= 0n || enabled !== true) throw new MixPayloadError('consent.policy');
      if (lower(recipient) !== lower(owner)) throw new MixPayloadError('consent.owner');
      once('policy');
    } else if (book.assets.has(to) || pin?.tokens.has(to)) {
      const d = decodeOrNull(erc20Abi, c.data);
      if (d?.functionName !== 'approve') throw new MixPayloadError('consent.to');
      const [spender, amount] = d.args as readonly [string, bigint];
      const who = lower(spender);
      if (isSwapper(who)) {
        // 補差額合約：宣告的就是釘住的那個才認，而且只能是 USDT 與借款幣。
        if (swapper === undefined || who !== swapper.address) throw new MixPayloadError('consent.swapper');
        if (!swapper.tokens.has(to)) throw new MixPayloadError('consent.asset');
        if (amount !== maxUint256) throw new MixPayloadError('consent.spender');
        once('swapper:' + to); out.cashSwapper = swapper.address;
        continue;
      }
      if (who !== v2.executor || amount !== maxUint256 || !book.assets.has(to)) throw new MixPayloadError('consent.spender');
      once('approve:' + to);
    } else {
      const d = decodeOrNull(STRATEGY_CONSENT_ABI, c.data);
      if (d?.functionName !== 'updateDelegate' && d?.functionName !== 'setAuthorization') throw new MixPayloadError('consent.to');
      const [delegate, allow] = d.args as readonly [string, boolean];
      if (lower(delegate) !== v2.executor || allow !== true) throw new MixPayloadError('consent.delegate');
      const venue = d.functionName === 'updateDelegate' ? 'venus' : 'lista';
      once(venue); out[venue] = to;
    }
  }
  if (!seen.has('policy')) throw new MixPayloadError('consent.incomplete');
  return out;
}

/** 讀鏈（`readOnlyClient().readContract` 的形狀）；測試換成假的。 */
export type MixChainRead = (call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => Promise<unknown>;

/**
 * 路由 v2 的地址是後端宣告的，簽名前在鏈上核對（讀不到就不簽）：
 * - 宣告的 registry 自己說的 `executor()` 就是宣告的 executor；委託的場所就是它的 `venusComptroller()`／`moolah()`；
 * - 這個帳戶已經核准過這個 executor 動用 USDT（開啟加息時的同意就有這一筆；USDT 的地址在 App 的地址簿裡，假不了）。
 *   所以改比例這一筆不會把資產交給帳戶沒授權過的新對象，只會延續既有的授權。
 * - 有核准給補差額合約時（地址已經是 App 釘住的）：它自己說的 `executor()`、`borrowRegistry()` 就是上面核對過的那一組，
 *   `usdt()` 就是地址簿的 USDT。換了 v2 合約組而 App 還釘著舊 swapper 時會在這裡擋下。
 */
export async function assertStrategyV2(v2: CheckedStrategyV2 | undefined, account: string, usdt: string | undefined = CHAIN.contracts?.usdt,
  read: MixChainRead = (call) => readOnlyClient().readContract(call as never)): Promise<void> {
  if (v2 === undefined) return;
  if (usdt === undefined) throw new MixPayloadError('address book');
  const registry = v2.registry as Address;
  const swapper = v2.cashSwapper as Address | undefined;
  let executor: unknown, allowance: unknown, venus: unknown, lista: unknown, bound: unknown[] | null;
  try {
    [executor, allowance, venus, lista, bound] = await Promise.all([
      read({ address: registry, abi: STRATEGY_V2_ABI, functionName: 'executor' }),
      read({ address: usdt as Address, abi: erc20Abi, functionName: 'allowance', args: [account, v2.executor] }),
      v2.venus === undefined ? null : read({ address: registry, abi: STRATEGY_V2_ABI, functionName: 'venusComptroller' }),
      v2.lista === undefined ? null : read({ address: registry, abi: STRATEGY_V2_ABI, functionName: 'moolah' }),
      swapper === undefined ? null : Promise.all((['executor', 'borrowRegistry', 'usdt'] as const).map((functionName) => read({ address: swapper, abi: CASH_SWAPPER_ABI, functionName }))),
    ]);
  } catch {
    throw new MixPayloadError('consent.v2 unreadable');
  }
  if (typeof executor !== 'string' || lower(executor) !== v2.executor) throw new MixPayloadError('consent.v2 executor');
  if (typeof allowance !== 'bigint' || allowance <= 0n) throw new MixPayloadError('consent.v2 allowance');
  if (v2.venus !== undefined && (typeof venus !== 'string' || lower(venus) !== v2.venus)) throw new MixPayloadError('consent.v2 venue');
  if (v2.lista !== undefined && (typeof lista !== 'string' || lower(lista) !== v2.lista)) throw new MixPayloadError('consent.v2 venue');
  if (bound !== null && [v2.executor, v2.registry, lower(usdt)].some((want, i) => typeof bound[i] !== 'string' || lower(bound[i] as string) !== want)) throw new MixPayloadError('consent.v2 swapper');
}

/**
 * 核對過的簽名資料，外加最後一筆 enroll 的鏈上 strategy id（和 payload 的 `strategyId` 是後端資料庫的 id，兩者不同）。
 * `strategyV2`：這組 calls 帶了路由 v2 的重新同意（形狀已核對，地址還要 `assertStrategyV2` 在鏈上核對）。
 */
export type CheckedPayload = Omit<MixSigningPayload, 'strategyV2'> & { onchainId: bigint; strategyV2?: CheckedStrategyV2 };

/** 核對後端的簽名資料：形狀、每一筆 calldata 解碼後的函式與參數。不改內容。`owner`：簽名的錢包（路由 v2 的獎勵收款人只能是它）。 */
export function checkSigningPayload(body: unknown, book: MixCallBook = mixCallBook(), owner?: string): CheckedPayload {
  if (typeof body !== 'object' || body === null) throw new MixPayloadError('body');
  const p = body as Record<string, unknown>;
  if (!Number.isSafeInteger(p.mixId) || (p.mixId as number) <= 0) throw new MixPayloadError('mixId');
  if (!Number.isSafeInteger(p.strategyId) || (p.strategyId as number) <= 0) throw new MixPayloadError('strategyId');
  if (typeof p.account !== 'string' || !ADDRESS.test(p.account)) throw new MixPayloadError('account');
  if (p.signingMode !== 'sudo') throw new MixPayloadError('signingMode');
  if (p.expectedVersion !== 1) throw new MixPayloadError('expectedVersion');
  if (typeof p.nonce !== 'string' || !/^\d{1,78}$/.test(p.nonce)) throw new MixPayloadError('nonce');
  // 12 筆 approve＋enroll，加息策略開著時再加完整的重新同意（2 個委託＋每個資產上限與核准＋2 筆核准），同 backend MAX_MIX_OWNER_CALLS。
  if (!Array.isArray(p.calls) || p.calls.length === 0 || p.calls.length > 36) throw new MixPayloadError('calls');
  if (book.registry === '' || book.executor === '') throw new MixPayloadError('address book');
  const calls = p.calls as unknown[];
  let onchainId: bigint | null = null;
  // enroll 的位置：registry 上第一筆能解成 enroll 的 call；沒有就當最後一筆（下面會報 enroll.*）。
  const at = (() => { const i = calls.findIndex((call) => { const c = call as Record<string, unknown> | null;
    return c !== null && typeof c.to === 'string' && lower(c.to) === book.registry && typeof c.data === 'string' && HEX.test(c.data) &&
      decodeOrNull(REGISTRY_ABI, c.data as Hex)?.functionName === 'enroll'; }); return i < 0 ? calls.length - 1 : i; })();
  const consent: { to: string; data: Hex }[] = [];
  calls.forEach((call, index) => {
    const c = call as Record<string, unknown> | null;
    if (c === null || typeof c.to !== 'string' || !ADDRESS.test(c.to)) throw new MixPayloadError('calls.to');
    if (c.value !== '0') throw new MixPayloadError('calls.value');
    if (typeof c.data !== 'string' || !HEX.test(c.data) || c.data.length < 10) throw new MixPayloadError('calls.data');
    if (index > at) { consent.push({ to: c.to, data: c.data as Hex }); return; }
    if (index === at) {
      // enroll：registry 的 enroll(帳戶, id, 1)。
      if (lower(c.to) !== book.registry) throw new MixPayloadError('enroll.to');
      const decoded = decodeOrNull(REGISTRY_ABI, c.data as Hex);
      if (decoded?.functionName !== 'enroll') throw new MixPayloadError('enroll.function');
      const [account, id, version] = decoded.args as readonly [string, bigint, number];
      if (lower(account) !== lower(p.account as string)) throw new MixPayloadError('enroll.account');
      if (id <= 0n) throw new MixPayloadError('enroll.id');
      if (version !== 1) throw new MixPayloadError('enroll.version');
      onchainId = id;
      return;
    }
    // 其餘：目錄資產或 USDT 的 approve(executor, max)。
    if (!book.assets.has(lower(c.to))) throw new MixPayloadError('approve.to');
    const decoded = decodeOrNull(erc20Abi, c.data as Hex);
    if (decoded?.functionName !== 'approve') throw new MixPayloadError('approve.function');
    const [spender, amount] = decoded.args as readonly [string, bigint];
    if (lower(spender) !== book.executor) throw new MixPayloadError('approve.spender');
    if (amount !== maxUint256) throw new MixPayloadError('approve.amount');
  });
  if (onchainId === null) throw new MixPayloadError('enroll');
  const { strategyV2: _declared, ...rest } = p as unknown as MixSigningPayload;
  // 路由 v2：後端宣告了 v2 的地址，而且 enroll 後面有一筆是給那個 registry 的。其餘情況照 v1 核對（v1 的行為不變）。
  const v2 = declaredStrategyV2(p.strategyV2, book);
  if (v2 !== undefined && consent.some((c) => lower(c.to) === v2.registry)) {
    if (book.strategy === undefined) throw new MixPayloadError('consent.chain');
    return { ...rest, onchainId, strategyV2: checkStrategyConsentV2(consent, book, v2, owner) };
  }
  checkStrategyConsent(consent, book);
  return { ...rest, onchainId };
}

/** 後端宣告的 v2 地址（小寫）。`cashSwapper`：補差額合約，沒宣告就沒有這一項。 */
type DeclaredStrategyV2 = { registry: string; executor: string; cashSwapper?: string };

/**
 * 後端宣告的 v2 地址：兩個不同的地址，而且不是 App 已知的任何合約或資產（AtpRegistry、AtpExecutor、v1 的加息合約、代幣、
 * 釘住的補差額合約與借款幣）。`cashSwapper` 可以不宣告；宣告了就要是第三個不同的地址，同樣不能是已知的合約或代幣。
 * 它是不是 App 釘住的那個，到 `checkStrategyConsentV2` 真的有核准給它時才要求（沒用到就不影響改比例）。
 */
function declaredStrategyV2(value: unknown, book: MixCallBook): DeclaredStrategyV2 | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v !== 'object' || typeof v.registry !== 'string' || !ADDRESS.test(v.registry) || typeof v.executor !== 'string' || !ADDRESS.test(v.executor)) throw new MixPayloadError('strategyV2');
  const registry = lower(v.registry), executor = lower(v.executor), s = book.strategy, pin = book.cashSwapper;
  const known = new Set([book.registry, book.executor, ...book.assets, ...(s ? [s.executor, s.registry, s.venus, s.lista, s.vault] : [])]);
  const pinned = new Set(pin ? [pin.address, ...pin.tokens] : []);
  if (registry === executor || [registry, executor].some((a) => known.has(a) || pinned.has(a))) throw new MixPayloadError('strategyV2');
  if (v.cashSwapper === undefined || v.cashSwapper === null) return { registry, executor };
  if (typeof v.cashSwapper !== 'string' || !ADDRESS.test(v.cashSwapper)) throw new MixPayloadError('strategyV2');
  const cashSwapper = lower(v.cashSwapper);
  if (cashSwapper === registry || cashSwapper === executor || known.has(cashSwapper) || pin?.tokens.has(cashSwapper)) throw new MixPayloadError('strategyV2');
  return { registry, executor, cashSwapper };
}

function decodeOrNull<const Abi extends readonly unknown[]>(abi: Abi, data: Hex) {
  try {
    const decoded = decodeFunctionData({ abi: abi as never, data }) as { functionName: string; args: readonly unknown[] };
    // 再編碼一次要和原 data 完全一樣：多塞尾巴或不標準編碼的 calldata 不簽。
    const again = (encodeFunctionData as (input: unknown) => Hex)({ abi, functionName: decoded.functionName, args: decoded.args });
    return lower(again) === lower(data) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * 鏈上這個 id 的第 1 版要就是用戶挑的那一組（審查第 4 點的「strategy 等於回傳值」）：
 * 用戶挑的每一個都在、比例相同。多出來的只能是：
 * - USDT 0 bp：後端每個 mix 都會加這一筆（backend `mix-domain.ts` 的 `mixChainAllocation`；合約允許 numeraire 權重為 0）；
 * - 改比例時「只賣不買」的舊資產，各 1 bp，從最大的成分扣。
 */
export function versionMatchesPicks(
  onchain: { assets: readonly string[]; weightsBps: readonly number[] },
  picks: readonly MixAsset[],
  numeraire: string = CHAIN.contracts?.usdt ?? '',
): boolean {
  if (onchain.assets.length !== onchain.weightsBps.length) return false;
  const chain = new Map(onchain.assets.map((asset, index) => [lower(asset), onchain.weightsBps[index] ?? 0]));
  const wanted = new Map(picks.map((pick) => [lower(pick.assetId), pick.weightBps]));
  const extras = [...chain.entries()].filter(([asset]) => !wanted.has(asset));
  const cash = lower(numeraire);
  if (extras.some(([asset, weight]) => !(weight === 1 && asset !== cash) && !(asset === cash && weight === 0))) return false;
  const sellOnly = extras.filter(([, weight]) => weight === 1).length;
  for (const [asset, weight] of wanted) {
    const actual = chain.get(asset);
    if (actual === undefined || Math.abs(actual - weight) > sellOnly) return false;
  }
  return true;
}

async function assertEnrollTarget(onchainId: bigint, picks: readonly MixAsset[] | undefined): Promise<void> {
  const registry = CHAIN.contracts?.registry as Address | undefined;
  if (registry === undefined) throw new MixPayloadError('address book');
  let version: { assets: readonly string[]; weightsBps: readonly number[] };
  try {
    version = await readOnlyClient().readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'version', args: [onchainId, 1] }) as never;
  } catch {
    throw new MixPayloadError('enroll.strategy unreadable');
  }
  const catalog = mixCallBook().assets;
  if (version.assets.length === 0 || version.assets.some((asset) => !catalog.has(lower(asset)))) throw new MixPayloadError('enroll.strategy assets');
  if (picks !== undefined && !versionMatchesPicks(version, picks)) throw new MixPayloadError('enroll.strategy picks');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type MixStage = 'sign' | 'confirm' | 'fund';

/**
 * 簽後端準備好的那一組 calls，上鏈後請後端確認。`picks`：用戶這次挑的資產與比例（建立、Change mix）；
 * 從組合頁的 Finish 補簽時不知道新比例，只核對鏈上資產都在目錄裡。
 * 回傳 `portfolioId`：後端已經建好（null＝還在對帳，稍後明細會自己更新）。
 */
export async function signMix(args: {
  wallet: RenewalWallet;
  token: string;
  payload: unknown;
  picks?: readonly MixAsset[];
  onStage?: (stage: MixStage) => void;
  wait?: (ms: number) => Promise<void>;
}): Promise<{ mixId: number; account: Address; portfolioId: number | null }> {
  const payload = checkSigningPayload(args.payload, mixCallBook(), args.wallet.address);
  const account = payload.account as Address;
  const wait = args.wait ?? sleep;
  args.onStage?.('sign');
  await assertEnrollTarget(payload.onchainId, args.picks);
  await assertStrategyV2(payload.strategyV2, account);
  await waitForAccountCode((address) => readOnlyClient().getCode({ address }), account);
  const receipt = await sendSudoCalls({
    wallet: args.wallet,
    token: args.token,
    accountAddress: account,
    // 帳戶已部署、地址明確傳入，這個 id 只用來推導 factory 參數（不會送出）；改成分時是新的 strategy 也沒關係。
    strategyId: payload.strategyId,
    calls: payload.calls.map((call) => ({ to: call.to as Address, data: call.data as Hex, value: 0n })),
    nonce: BigInt(payload.nonce as string),
  });
  if (!receipt.success) throw new ApiError(0, 'MIX_SIGNED_REVERTED', `reverted: ${receipt.txHash}`);
  args.onStage?.('confirm');
  // RPC 慢一兩個塊時後端還看不到收據：重試幾次，還是不行就交給後端自己對帳。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const confirmed = await mixApi.confirm(args.token, payload.mixId, receipt.txHash);
      return { mixId: payload.mixId, account, portfolioId: Number.isSafeInteger(confirmed.portfolioId) ? confirmed.portfolioId : null };
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.code !== 'MIX_BUSY') break;
      await wait(3_000);
    }
  }
  return { mixId: payload.mixId, account, portfolioId: null };
}

/**
 * 建立的回應裡 calls 是空的（第一次的意圖超過 15 分鐘已過期，或其實已經確認過）：重讀 enrollment-params。
 * 回 null＝已經確認過，不用再簽。
 */
export async function freshCreationPayload(token: string, created: MixSigningPayload): Promise<MixSigningPayload | null> {
  if (created.calls.length > 0) return created;
  try {
    return await mixApi.prepare(token, created.mixId);
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'MIX_NO_PENDING_CHANGE') return null;
    throw cause;
  }
}

/* ── 入金 ─────────────────────────────────────── */

export type MixFundingSource = { kind: 'wallet_transfer'; txHash: string } | { kind: 'faucet_claim'; claimId: string };
const PENDING_KEY = 'cre8.mixFunding.v1';
/**
 * 待補記的入金用 mixId 當 key（`m:<mixId>`）：改比例確認後 portfolioId 會換，補記時送最新的那個。
 * 舊版用 portfolioId 當 key（純數字），讀的時候搬過來。
 */
const mixKey = (mixId: number) => `m:${mixId}`;

function readPending(): Record<string, MixFundingSource[]> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PENDING_KEY) ?? '{}') as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, MixFundingSource[]> : {};
  } catch {
    return {};
  }
}
function writePending(all: Record<string, MixFundingSource[]>): void {
  try { window.localStorage.setItem(PENDING_KEY, JSON.stringify(all)); } catch { /* 存不了就只靠這次的重試。 */ }
}
const sameSource = (a: MixFundingSource, b: MixFundingSource) => a.kind === b.kind && (a.kind === 'wallet_transfer' ? a.txHash === (b as typeof a).txHash : a.claimId === (b as typeof a).claimId);
const merge = (list: MixFundingSource[], more: MixFundingSource[]) => [...list, ...more.filter((item) => !list.some((have) => sameSource(have, item)))];

/** 這個組合待補記的入金。`legacyPortfolioId`：舊版以 portfolioId 存的那一份，一起搬到 mixId 底下。 */
export function pendingMixFunding(mixId: number, legacyPortfolioId: number | null = null): MixFundingSource[] {
  const all = readPending();
  if (legacyPortfolioId !== null && all[String(legacyPortfolioId)] !== undefined) {
    all[mixKey(mixId)] = merge(all[mixKey(mixId)] ?? [], all[String(legacyPortfolioId)] ?? []);
    delete all[String(legacyPortfolioId)];
    writePending(all);
  }
  return all[mixKey(mixId)] ?? [];
}
function rememberFunding(mixId: number, source: MixFundingSource): void {
  const all = readPending();
  all[mixKey(mixId)] = merge(all[mixKey(mixId)] ?? [], [source]);
  writePending(all);
}
function forgetFunding(mixId: number, source: MixFundingSource): void {
  const all = readPending();
  const list = (all[mixKey(mixId)] ?? []).filter((item) => !sameSource(item, source));
  if (list.length === 0) delete all[mixKey(mixId)];
  else all[mixKey(mixId)] = list;
  writePending(all);
}

/** 收據還沒被後端的 RPC 看到、後端忙、改比例還沒確認、網路斷：值得再試。 */
function fundingRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.status === 0 || error.status >= 500) return true;
  return ['FUNDING_NOT_CONFIRMED', 'PORTFOLIO_BUSY', 'MIX_BUSY', 'MIX_SWITCH_PENDING'].includes(error.code);
}

/** 不能再試的（來源不屬於這個組合、已被改比例承接等）：不留著，免得每次打開組合頁都重送。 */
function fundingSettled(error: unknown): boolean {
  return error instanceof ApiError && ['FUNDING_EVENT_CONFLICT', 'MIX_FUNDING_ALREADY_CARRIED', 'INVALID_FUNDING_SOURCE'].includes(error.code);
}

/**
 * 把這筆入金記成組合的投入（`POST /portfolios/:portfolioId/funding-lots`）。同一個來源重送不會重記。
 * 先存起來（以 mixId 為 key）再送；記好才刪。回 true＝記好了。
 */
export async function recordMixFunding(args: {
  token: string;
  mixId: number;
  portfolioId: number;
  source: MixFundingSource;
  attempts?: number;
  wait?: (ms: number) => Promise<void>;
  post?: typeof postFundingLot;
}): Promise<boolean> {
  const { token, mixId, portfolioId, source, attempts = 6, wait = sleep, post = postFundingLot } = args;
  rememberFunding(mixId, source);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await post(token, portfolioId, source);
      forgetFunding(mixId, source);
      return true;
    } catch (cause) {
      if (fundingSettled(cause)) { forgetFunding(mixId, source); return true; }
      if (!fundingRetryable(cause) || attempt === attempts - 1) return false;
      await wait(3_000);
    }
  }
  return false;
}

/** 組合頁打開時：上次沒記好的入金，用目前的 portfolioId 補記。回補記好的筆數。 */
export async function settlePendingMixFunding(token: string, mixId: number, portfolioId: number, options: { post?: typeof postFundingLot } = {}): Promise<number> {
  let settled = 0;
  for (const source of pendingMixFunding(mixId, portfolioId)) {
    if (await recordMixFunding({ token, mixId, portfolioId, source, attempts: 2, ...options })) settled += 1;
  }
  return settled;
}

/** 錢包裡的 USDT（18 位小數）。讀不到回 null。 */
export async function readWalletUsdt(owner: string): Promise<bigint | null> {
  const usdt = CHAIN.contracts?.usdt;
  if (usdt === undefined || !ADDRESS.test(owner)) return null;
  try {
    return await readOnlyClient().readContract({ address: usdt as Address, abi: ERC20_BALANCE, functionName: 'balanceOf', args: [owner as Address] });
  } catch {
    return null;
  }
}

/** 錢包 → 組合帳戶轉 USDT。測試網錢包沒 tBNB 時先請後端補（同基金頁）。回交易 hash（之後記成入金）。 */
export async function sendUsdtToMix(args: { wallet: RenewalWallet; token: string; account: Address; amount: bigint }): Promise<Hex> {
  const usdt = CHAIN.contracts?.usdt as Address | undefined;
  if (usdt === undefined) throw new ApiError(0, 'MIX_CHAIN_UNAVAILABLE', 'no USDT on this chain');
  await assertRpcChain();
  if (CHAIN.faucetFunded) {
    const reader = publicClientFor(args.wallet);
    await ensureOwnerGas({
      readBalance: () => reader.getBalance({ address: args.wallet.address as Address }),
      requestGas: () => postGasFaucet(args.token),
      waitForTx: async (hash) => { await reader.waitForTransactionReceipt({ hash: hash as Hex, timeout: 30_000 }); },
    });
  }
  const data = transferCalldata(args.account, args.amount);
  let hash: Hex;
  if (args.wallet.kind === 'dev') {
    const rpcUrl = readRpcUrl();
    if (rpcUrl === undefined || rpcUrl === '') throw new Error('dev mode needs VITE_RPC_URL');
    hash = await createWalletClient({ account: args.wallet.account, chain: appChain, transport: http(rpcUrl) }).sendTransaction({ to: usdt, data, chain: appChain });
  } else {
    hash = await createWalletClient({ account: args.wallet.address as Address, chain: appChain, transport: custom(args.wallet.provider as never) })
      .sendTransaction({ to: usdt, data, chain: appChain });
  }
  const receipt = await publicClientFor(args.wallet).waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new ApiError(0, 'MIX_TRANSFER_REVERTED', `reverted: ${hash}`);
  return hash;
}

/** 測試網：把今天的 1,000 測試 USDT 直接領進組合帳戶（帳戶要先確認好，後端才認得）。回 claimId（之後記成入金）。 */
export async function claimTestUsdtToMix(token: string, account: Address): Promise<string> {
  let body: Awaited<ReturnType<typeof postFaucetUsdt>>;
  try {
    body = await postFaucetUsdt(token, account);
  } catch (cause) {
    throw new ApiError(cause instanceof ApiError ? cause.status : 0, 'MIX_FAUCET_FAILED', faucetFailure(cause).message);
  }
  if (typeof body.claimId !== 'string' || body.claimId === '') throw new ApiError(0, 'MIX_FAUCET_FAILED', faucetFailure(null).message);
  // 等那筆 mint 上鏈，後端才讀得到收據。
  if (typeof body.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    await readOnlyClient().waitForTransactionReceipt({ hash: body.txHash as Hex, timeout: 60_000 }).catch(() => undefined);
  }
  return body.claimId;
}

/**
 * 放錢進組合（錢包轉帳或測試 USDT），再記成入金。回 `recorded`：false＝錢已進帳戶、還沒記好（組合頁會補記）。
 */
export async function fundMix(args: {
  wallet: RenewalWallet;
  token: string;
  account: Address;
  mixId: number;
  portfolioId: number;
  with: { kind: 'wallet'; amount: bigint } | { kind: 'test-usdt' };
}): Promise<{ recorded: boolean }> {
  const source: MixFundingSource = args.with.kind === 'test-usdt'
    ? { kind: 'faucet_claim', claimId: await claimTestUsdtToMix(args.token, args.account) }
    : { kind: 'wallet_transfer', txHash: await sendUsdtToMix({ wallet: args.wallet, token: args.token, account: args.account, amount: args.with.amount }) };
  return { recorded: await recordMixFunding({ token: args.token, mixId: args.mixId, portfolioId: args.portfolioId, source }) };
}

/** 組合帳戶裡的 USDT（退出後全是 USDT）。 */
export async function readMixUsdt(account: string): Promise<bigint | null> {
  return readWalletUsdt(account);
}

/** 把組合帳戶裡的 USDT 全部領回自己的錢包（owner 簽；後端只代付「USDT 轉回本人」）。 */
export async function withdrawMixUsdt(args: { wallet: RenewalWallet; token: string; account: Address; strategyId: number; amount: bigint }): Promise<void> {
  const usdt = CHAIN.contracts?.usdt as Address | undefined;
  if (usdt === undefined) throw new ApiError(0, 'MIX_CHAIN_UNAVAILABLE', 'no USDT on this chain');
  const receipt = await sendWithdraw({
    wallet: args.wallet, token: args.token, accountAddress: args.account, asset: usdt,
    recipient: args.wallet.address as Address, amountWei: args.amount, strategyId: args.strategyId,
  });
  if (!receipt.success) throw new ApiError(0, 'MIX_TRANSFER_REVERTED', `reverted: ${receipt.txHash}`);
}

/** 錢包 USDT 餘額（Buy 頁判斷要轉錢包的錢還是領測試 USDT）。 */
export function useWalletUsdt(owner: string | null | undefined) {
  return useQuery({
    queryKey: ['mix-wallet-usdt', owner ?? ''],
    queryFn: () => readWalletUsdt(owner ?? ''),
    enabled: typeof owner === 'string' && ADDRESS.test(owner),
    staleTime: 15_000,
  });
}
