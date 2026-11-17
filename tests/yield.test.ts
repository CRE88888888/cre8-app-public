import { expect, test } from "bun:test";
import fs from "node:fs";
import { decodeFunctionData, erc20Abi, maxUint256, toFunctionSelector } from "viem";
import { activationDesign } from "../src/lib/activation-design";
import { typedVersionBody } from "../src/lib/fund-execution";
import { TESTNET_97 } from "../src/lib/testnet-97";
import { testnetToken } from "../src/lib/testnet-catalogue";
import {
  CANCELLED_LENT_LABEL,
  CASH_PICK,
  CONSENT_DAILY_ASSETS,
  SIMULATED_RATE_LABEL,
  STATE_LABEL,
  YIELD_REGISTRY_ABI,
  aprText,
  cancelledButLent,
  consentCalls,
  consentable,
  exitCalls,
  exitDoneMessage,
  exitInProgress,
  marketLabel,
  marketsFor,
  parsePortfolioYield,
  parseYieldMarkets,
  pendingReasonText,
  prunePicks,
  readYieldPicks,
  revocable,
  revokeCalls,
  setYieldPick,
  stalePicks,
  stoppable,
  type AssetYield,
  type PendingReason,
  type YieldMarket,
  YieldStateInvalidError,
} from "../src/lib/yield";
import { MOCK_MARKETS_97, mockPortfolioYield } from "../src/lib/yield-mock";
import * as B from "../src/reference/lib/fund-builder";

// APP-3（cre8-app#81）：逐資產選市場、模擬利率標記、買家同意與停止生息並全部領回、估值與待領回、生息權限。
// 合約 cre8-contracts#49；後端契約照 C3 在 backend#84 的留言（BE-3／BE-4 開出來之前用 mock）。

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const BTC = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
const REGISTRY = TESTNET_97.contracts.yieldRegistry.toLowerCase();
const EXECUTOR = TESTNET_97.contracts.executor.toLowerCase();

const market = (over: Partial<YieldMarket> = {}): YieldMarket => ({
  id: "venus-usdt",
  marketId: `0x${"11".repeat(32)}`,
  protocol: "venus",
  asset: USDT,
  symbol: "USDT",
  receipt: "0x445b4b553a4665a749e2b972d2c83e2d08cbb207",
  aprBps: 500,
  simulated: true,
  supplyOpen: true,
  dataAt: null,
  ...over,
});

const row = (over: Partial<AssetYield> = {}): AssetYield => ({
  asset: USDT,
  symbol: "USDT",
  market: "venus-usdt",
  state: "not_consented",
  receiptValue: null,
  pending: null,
  dataAt: null,
  claimAssets: null,
  maxWithdraw: null,
  valuationState: null,
  consented: null,
  ...over,
});

test("the chain 97 mock has the 30 simulated markets of cre8-contracts#49: USDT and 20 assets on Venus, Lista and Aave", () => {
  const markets = MOCK_MARKETS_97.markets;
  expect(markets).toHaveLength(30);
  expect(markets.every((item) => item.simulated)).toBe(true);
  expect(markets.filter((item) => item.protocol === "venus")).toHaveLength(21);
  expect(markets.filter((item) => item.protocol === "lista")).toHaveLength(4);
  expect(markets.filter((item) => item.protocol === "aave_v3")).toHaveLength(5);
  expect(new Set(markets.map((item) => item.symbol)).size).toBe(21);
  expect(new Set(markets.map((item) => item.id)).size).toBe(30);
  expect(new Set(markets.map((item) => item.marketId)).size).toBe(30);
  // 換成 app 現在的測試網位址：每個市場的資產都要對得上帳戶會持有的代幣（不是 fork manifest 的位址）。
  for (const item of markets) {
    const expected = item.symbol === "USDT" ? TESTNET_97.contracts.usdt : testnetToken(item.symbol);
    expect(expected).not.toBeNull();
    expect(item.asset).toBe(expected!.toLowerCase());
  }
  expect(markets.find((item) => item.id === "venus_usdt")?.aprBps).toBe(500);
  expect(markets.find((item) => item.id === "lista_usdt")?.aprBps).toBe(300);
  expect(markets.find((item) => item.id === "aave_v3_usdt")?.aprBps).toBe(300);
  // 與地址簿同一份 manifest（cre8-contracts 公開部署的 manifest）：registry 是地址簿的 yieldRegistry。
  expect(MOCK_MARKETS_97.registry).toBe(TESTNET_97.contracts.yieldRegistry.toLowerCase());
  expect(TESTNET_97.contracts.yieldRegistry).toBe("0xA234531b1ace7B7106562A5554f1F8b173F7087b");
  expect(TESTNET_97.contracts.yieldView).toBe("0xC8EEBa84f9C74B2D879dFaEdb02a0a523aA02657");
  expect(TESTNET_97.contracts.executor).toBe("0xB65Ec2EC6f5aB0a345b50cAA454cf792C1EF2bB9");
  expect(TESTNET_97.source.commit).toBe("a23afbfccbd449ec141bea06ab35f40ca6c1b1eb");
  // 平台市場 id 照後端 yield-domain.ts 的 `${protocol}_${symbol}`。
  for (const item of markets) expect(item.id).toBe(`${item.protocol}_${item.symbol.toLowerCase()}`);
});

test("the market list is parsed strictly: a market that does not say whether it is simulated is dropped", () => {
  const good = { id: "venus-usdt", marketId: `0x${"ab".repeat(32)}`, protocol: "venus", asset: USDT.toUpperCase().replace("0X", "0x"), symbol: "USDT", receipt: "0x445b4b553a4665a749e2b972d2c83e2d08cbb207", aprBps: 500, simulated: true };
  const parsed = parseYieldMarkets({ chainId: 97, registry: REGISTRY, markets: [
    good,
    { ...good, id: "no-flag", simulated: undefined },
    { ...good, id: "Bad Slug" },
    { ...good, id: "short-id", marketId: "0x1234" },
    { ...good, id: "odd-protocol", protocol: "compound" },
    { ...good, id: "neg-apr", aprBps: -1 },
    { ...good, id: "closed", supplyOpen: false },
    good,
  ] })!;
  expect(parsed.markets.map((item) => item.id)).toEqual(["venus-usdt", "closed"]);
  expect(parsed.markets[0]!.asset).toBe(USDT);
  expect(parsed.markets[1]!.supplyOpen).toBe(false);
  expect(parseYieldMarkets({ chainId: 97, registry: "nope", markets: [] })).toBeNull();
  expect(parseYieldMarkets({ chainId: 0, registry: REGISTRY, markets: [] })).toBeNull();
  expect(parseYieldMarkets(null)).toBeNull();
});

test("an asset is only offered the markets it actually has, best rate first; closed markets are left out", () => {
  const list = [
    market(),
    market({ id: "lista-usdt", protocol: "lista", aprBps: 300 }),
    market({ id: "aave-v3-usdt", protocol: "aave_v3", aprBps: 700, supplyOpen: false }),
    market({ id: "venus-btcb", asset: BTC, symbol: "BTCB", aprBps: 12 }),
  ];
  expect(marketsFor(list, { address: USDT, symbol: "USDT" }).map((item) => item.id)).toEqual(["venus-usdt", "lista-usdt"]);
  expect(marketsFor(list, { address: BTC.toUpperCase().replace("0X", "0x"), symbol: "BTCB" }).map((item) => item.id)).toEqual(["venus-btcb"]);
  expect(marketsFor(list, { address: ETH, symbol: "ETH" })).toEqual([]);
  // 地址還不知道（設計器資產沒有這條鏈的地址）時用代號比對。
  expect(marketsFor(list, { address: null, symbol: "btcb" }).map((item) => item.id)).toEqual(["venus-btcb"]);
  expect(marketLabel(market())).toBe("Venus · 5.00% APR");
  expect(aprText(1)).toBe("0.01% APR");
});

test("backend#103 markets: an unreadable APR is null and shown as —, not dropped; is_simulated also counts; it is APR, not APY", () => {
  const good = { id: "venus-usdt", marketId: `0x${"ab".repeat(32)}`, protocol: "venus", asset: USDT, symbol: "USDT", receipt: "0x445b4b553a4665a749e2b972d2c83e2d08cbb207", aprBps: 500, simulated: true, supplyOpen: true, dataAt: "2026-11-16T08:00:00.000Z" };
  const parsed = parseYieldMarkets({ chainId: 97, registry: REGISTRY, markets: [
    good,
    { ...good, id: "no-rate", aprBps: null, supplyOpen: false },
    { ...good, id: "no-rate-open", aprBps: null, supplyOpen: true },
    // 審查 #95 第 6 項：沒給 supplyOpen、或不是 true，都當不收新存入。
    { ...good, id: "missing-open", supplyOpen: undefined },
    { ...good, id: "string-open", supplyOpen: "true" },
    { ...good, id: "snake-flag", simulated: undefined, is_simulated: true },
    { ...good, id: "bad-date", dataAt: "later" },
  ] })!;
  expect(parsed.markets.map((item) => item.id)).toEqual(["venus-usdt", "no-rate", "no-rate-open", "missing-open", "string-open", "snake-flag", "bad-date"]);
  expect(parsed.markets.filter((item) => item.id.endsWith("-open") && item.id !== "no-rate-open").map((item) => item.supplyOpen)).toEqual([false, false]);
  expect(parsed.markets[0]!.dataAt).toBe("2026-11-16T08:00:00.000Z");
  expect(parsed.markets[1]).toMatchObject({ aprBps: null, supplyOpen: false });
  // 讀不到 APR 的市場不收新存入，即使後端漏給 supplyOpen=false。
  expect(parsed.markets[2]!.supplyOpen).toBe(false);
  expect(parsed.markets[5]!.simulated).toBe(true);
  expect(parsed.markets[6]!.dataAt).toBeNull();
  expect(aprText(null)).toBe("APR —");
  expect(marketLabel(market({ aprBps: null }))).toBe("Venus · APR —");
  expect(marketsFor([market({ aprBps: null, supplyOpen: false }), market({ id: "lista-usdt" })], { address: USDT, symbol: "USDT" }).map((item) => item.id)).toEqual(["lista-usdt"]);
});

test("the simulated-rate label says 模擬利率 and every market view shows it for simulated markets", () => {
  expect(SIMULATED_RATE_LABEL).toContain("模擬利率");
  const tag = fs.readFileSync("src/components/YieldTag.tsx", "utf8");
  expect(tag).toContain("market.simulated && <> <SimulatedRate />");
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(designer).toContain("market.simulated && <><SimulatedRate />");
  expect(designer).toContain("pickedMarket(CASH_PICK)?.simulated && <SimulatedRate />");
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("<YieldTag market={market} />");
  expect(panel).toContain("anySimulated && <SimulatedRate />");
  const create = fs.readFileSync("src/features/create/CreateFundPage.tsx", "utf8");
  expect(create).toContain("lent on <YieldTag market={market} />");
});

test("the designer keeps each asset's market in the draft; reviveBuilder dropping it does not lose it", () => {
  expect(readYieldPicks({ rows: [], yieldPicks: { BTC: "venus-btcb", cash: "venus-usdt", ETH: "Not A Slug", SOL: 3 } })).toEqual({ BTC: "venus-btcb", cash: "venus-usdt" });
  expect(readYieldPicks({ rows: [] })).toEqual({});
  expect(readYieldPicks(null)).toEqual({});
  const picks = setYieldPick({ BTC: "venus-btcb" }, CASH_PICK, "lista-usdt");
  expect(picks).toEqual({ BTC: "venus-btcb", cash: "lista-usdt" });
  expect(setYieldPick(picks, "BTC", null)).toEqual({ cash: "lista-usdt" });
  expect(prunePicks({ BTC: "venus-btcb", ETH: "venus-eth", cash: "venus-usdt" }, ["BTC"])).toEqual({ BTC: "venus-btcb", cash: "venus-usdt" });
  const source = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(source).toContain("yieldPicks: readYieldPicks(raw)");
});

test("a picked market that this chain does not have for that asset is flagged so the creator picks again", () => {
  const list = [market(), market({ id: "venus-btcb", asset: BTC, symbol: "BTCB" })];
  const assets = [
    { key: "BTC", name: "BTC", address: BTC, symbol: "BTCB" },
    { key: "ETH", name: "ETH", address: ETH, symbol: "ETH" },
    { key: CASH_PICK, name: "Cash", address: USDT, symbol: "USDT" },
  ];
  expect(stalePicks({ BTC: "venus-btcb", cash: "venus-usdt" }, assets, list)).toEqual([]);
  // 別的資產的市場、清單裡沒有的市場、市場停止新存入：都要重選。
  expect(stalePicks({ BTC: "venus-usdt" }, assets, list)).toEqual(["BTC"]);
  expect(stalePicks({ ETH: "venus-eth" }, assets, list)).toEqual(["ETH"]);
  expect(stalePicks({ cash: "venus-usdt" }, assets, [market({ supplyOpen: false })])).toEqual(["Cash"]);
});

test("the published version carries each asset's market as yield.market, USDT included; no pick is null", () => {
  const body = typedVersionBody({
    chainId: 97,
    usdt: USDT,
    assets: [
      { address: BTC, weightBps: 6_000, yield: "venus-btcb" },
      { address: ETH, weightBps: 2_000 },
      { address: USDT, weightBps: 2_000, yield: "lista-usdt" },
    ],
  });
  expect(body.execution.assets).toEqual([
    { asset: BTC, weightBps: 6_000, execution: { kind: "hold" }, yield: { market: "venus-btcb" } },
    { asset: ETH, weightBps: 2_000, execution: { kind: "hold" }, yield: null },
    { asset: USDT, weightBps: 2_000, yield: { market: "lista-usdt" } },
  ]);
  // 整檔 idleYield 維持關閉：逐資產的 yield 取代它。
  expect(body.idleYield).toEqual({ enabled: false });
});

test("the activation page gets each asset's market by token address, cash included only when the fund keeps cash", () => {
  let state = B.addAsset(B.emptyBuilder(), "BTC", "demo");
  state = B.setShare(state, state.rows[0]!.id, 80);
  const withCash = activationDesign({ ...state, name: "Lent", yieldPicks: { BTC: "venus-btcb", cash: "venus-usdt", ETH: "venus-eth" } }, false)!;
  expect(withCash.yields).toEqual({ [BTC]: "venus-btcb", [USDT]: "venus-usdt" });
  const allIn = B.setShare(state, state.rows[0]!.id, 100);
  expect(activationDesign({ ...allIn, name: "All in", yieldPicks: { cash: "venus-usdt" } }, false)!.yields).toEqual({});
  expect(activationDesign({ ...state, name: "None" }, false)!.yields).toEqual({});
  const page = fs.readFileSync("src/features/create/CreateFundPage.tsx", "utf8");
  expect(page).toContain("...(marketOf(address) ? { yield: (marketOf(address) as YieldMarket).id } : {})");
  expect(page).toContain("staleYield.length === 0 && kindAgreed;");
});

test("consenting signs a receipt approval to the executor and setYieldPolicy for each ticked market, in one UserOp", () => {
  const usdtMarket = market({ marketId: `0x${"aa".repeat(32)}` });
  const btcMarket = market({ id: "venus-btcb", marketId: `0x${"bb".repeat(32)}`, asset: BTC, symbol: "BTCB", receipt: "0x1111111111111111111111111111111111111111" });
  const calls = consentCalls({ registry: REGISTRY, executor: EXECUTOR, markets: [usdtMarket, btcMarket] });
  expect(calls).toHaveLength(4);
  expect(calls.map((call) => call.to)).toEqual([usdtMarket.receipt, REGISTRY, btcMarket.receipt, REGISTRY]);
  expect(calls.every((call) => call.value === 0n)).toBe(true);
  const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data });
  expect(approve.functionName).toBe("approve");
  expect(approve.args).toEqual([expect.stringMatching(new RegExp(EXECUTOR, "i")), maxUint256]);
  expect(calls[1]!.data.slice(0, 10)).toBe(toFunctionSelector("setYieldPolicy(bytes32,uint256,bool)"));
  const policy = decodeFunctionData({ abi: YIELD_REGISTRY_ABI, data: calls[3]!.data });
  expect(policy.functionName).toBe("setYieldPolicy");
  // 每日上限一律 uint256 max（C3 決定：不另設每日金額上限，曝險由合約的 24 小時一次、50 USDT 下限與市場容量擋）。
  expect(policy.args).toEqual([btcMarket.marketId, maxUint256, true]);
  expect(CONSENT_DAILY_ASSETS).toBe(maxUint256);
  expect(fs.readFileSync("src/lib/yield.ts", "utf8")).not.toMatch(/item\.dailyAssets|row\.dailyAssets/);
  // 16 個資產全部同意 = 32 calls，剛好是 paymaster 一個 UserOp 的上限。
  expect(consentCalls({ registry: REGISTRY, executor: EXECUTOR, markets: Array.from({ length: 16 }, () => usdtMarket) })).toHaveLength(32);
});

test("stopping signs requestExit for every market that is agreed, lent or still withdrawing", () => {
  const a = market({ marketId: `0x${"aa".repeat(32)}` });
  const b = market({ id: "lista-usdt", protocol: "lista", marketId: `0x${"bb".repeat(32)}` });
  const calls = exitCalls({ registry: REGISTRY, markets: [a, b] });
  expect(calls.map((call) => call.to)).toEqual([REGISTRY, REGISTRY]);
  expect(calls[0]!.data.slice(0, 10)).toBe(toFunctionSelector("requestExit(bytes32)"));
  expect(decodeFunctionData({ abi: YIELD_REGISTRY_ABI, data: calls[1]!.data }).args).toEqual([b.marketId]);
  const rows = [
    row({ market: "a", state: "not_consented" }),
    row({ market: "b", state: "cash" }),
    row({ market: "c", state: "supplied" }),
    row({ market: "d", state: "exiting" }),
    row({ market: "e", state: "stopped" }),
  ];
  expect(stoppable(rows).map((item) => item.market)).toEqual(["b", "c", "d"]);
  expect(exitDoneMessage(0)).toContain("being withdrawn");
  expect(exitDoneMessage(1)).toContain("waiting to come back");
});

test("only markets still taking new deposits can be ticked", () => {
  const list = [market(), market({ id: "lista-usdt", protocol: "lista" }), market({ id: "closed", supplyOpen: false })];
  const rows = [
    row(),
    row({ market: "lista-usdt" }),
    row({ market: "closed" }),
    row({ market: "venus-usdt", state: "supplied" }),
    row({ market: "missing" }),
  ];
  expect(consentable(rows, list)).toEqual([rows[0]!, rows[1]!]);
  expect(consentable([row({ state: "stopped" })], list)).toHaveLength(1);
});

test("withdrawing everything is account-wide: while any market is still exiting, nothing can be agreed again (409 YIELD_EXIT_PENDING)", () => {
  const list = [market(), market({ id: "lista-usdt", protocol: "lista" })];
  const rows = [row(), row({ market: "lista-usdt", state: "exiting" })];
  expect(exitInProgress(rows)).toBe(true);
  expect(consentable(rows, list)).toEqual([]);
  expect(revocable(rows)).toEqual([]);
  expect(exitInProgress([row(), row({ market: "lista-usdt", state: "stopped" })])).toBe(false);
  expect(consentable([row(), row({ market: "lista-usdt", state: "stopped" })], list)).toHaveLength(2);
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("you can agree to lend");
  expect(panel).toContain("You cannot agree to lend again until everything is back.");
});

test("cancelling consent signs setYieldPolicy(marketId, 0, false) and posts to /yield/revoke; it is not the same as withdrawing everything", () => {
  const a = market({ marketId: `0x${"aa".repeat(32)}` });
  const calls = revokeCalls({ registry: REGISTRY, markets: [a] });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.to).toBe(REGISTRY);
  expect(calls[0]!.data.slice(0, 10)).toBe(toFunctionSelector("setYieldPolicy(bytes32,uint256,bool)"));
  expect(decodeFunctionData({ abi: YIELD_REGISTRY_ABI, data: calls[0]!.data }).args).toEqual([a.marketId, 0n, false]);
  const rows = [
    row({ market: "a", state: "not_consented" }),
    row({ market: "b", state: "cash" }),
    row({ market: "c", state: "supplied" }),
    row({ market: "e", state: "stopped" }),
  ];
  expect(revocable(rows).map((item) => item.market)).toEqual(["b", "c"]);
  const api = fs.readFileSync("src/lib/api.ts", "utf8");
  expect(api).toContain("/portfolios/${id}/yield/revoke");
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("revoke: postYieldRevoke");
  expect(panel).toContain("Cancelling consent only stops new lending");
  expect(panel).toContain("nothing is withdrawn");
});

test("backend#105 consented=false with receipts still there reads 'consent cancelled, still lent' and hides Cancel; without the field nothing changes", () => {
  const cancelled = row({ market: "c", state: "supplied", consented: false });
  expect(cancelledButLent(cancelled)).toBe(true);
  expect(revocable([cancelled])).toEqual([]);
  // 後端還沒給這個欄位（null）：照舊可以取消。
  expect(cancelledButLent(row({ state: "supplied" }))).toBe(false);
  expect(revocable([row({ market: "c", state: "supplied" })])).toHaveLength(1);
  expect(revocable([row({ market: "c", state: "supplied", consented: true })])).toHaveLength(1);
  // exit 之後也是 false，但那時是 exiting，照退出中顯示。
  expect(cancelledButLent(row({ state: "exiting", consented: false }))).toBe(false);
  expect(CANCELLED_LENT_LABEL.label).toContain("still lent");
  const parsed = parsePortfolioYield({ permission: "ok", accountValue: null, assets: [
    { asset: USDT, symbol: "USDT", market: "venus-usdt", state: "supplied", consented: false },
    { asset: BTC, symbol: "BTCB", market: "venus-btcb", state: "supplied", consented: "yes" },
  ] })!;
  expect(parsed.assets.map((item) => item.consented)).toEqual([false, null]);
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("cancelled ? { ...CANCELLED_LENT_LABEL");
});

test("the holder's yield state never turns an unknown value into 0, and unknown reasons stay unknown", () => {
  const parsed = parsePortfolioYield({
    permission: "needs_update",
    accountValue: "oops",
    assets: [
      { asset: USDT, symbol: "USDT", market: "venus-usdt", state: "exiting", receiptValue: null, pending: { value: "40", reason: "governance" }, dataAt: "2026-11-16T08:00:00Z" },
      { asset: BTC, symbol: "BTCB", market: "venus-btcb", state: "supplied", receiptValue: "125", pending: null, dataAt: "not a date", claimAssets: "7", maxWithdraw: "3", valuationState: "known" },
    ],
  })!;
  // 審查 #95 第 6 項：任何一列格式不對（狀態不認得、地址不對、不是物件）整份進 error，不留部分清單。
  for (const bad of [{ asset: ETH, market: "venus-eth", state: "lent" }, { asset: "nope", market: "venus-x", state: "cash" }, null]) {
    expect(() => parsePortfolioYield({ assets: [{ asset: USDT, symbol: "USDT", market: "venus-usdt", state: "exiting" }, bad] })).toThrow(YieldStateInvalidError);
  }
  expect(parsed.permission).toBe("needs_update");
  expect(parsed.accountValue).toBeNull();
  expect(parsed.assets).toHaveLength(2);
  expect(parsed.assets[0]).toMatchObject({ receiptValue: null, pending: { value: "40", reason: "unknown" }, dataAt: "2026-11-16T08:00:00Z" });
  expect(parsed.assets[1]).toMatchObject({ receiptValue: "125", dataAt: null, claimAssets: "7", maxWithdraw: "3", valuationState: "known" });
  expect(parsed.assets[0]).toMatchObject({ claimAssets: null, maxWithdraw: null, valuationState: null });
  expect(parsePortfolioYield({ assets: [] })!.permission).toBe("unknown");
  expect(parsePortfolioYield(undefined)).toBeNull();
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("raw === null ? 'unknown'");
  expect(panel).toContain("row.valuationState === 'unknown' ? 'unknown'");
});

test("every waiting-to-come-back reason and state has words, and the panel shows the amount with the reason", () => {
  for (const reason of ["market_paused", "high_utilization", "low_liquidity", "unknown"] as PendingReason[]) expect(pendingReasonText(reason).length).toBeGreaterThan(10);
  expect(Object.keys(STATE_LABEL).sort()).toEqual(["cash", "exiting", "not_consented", "stopped", "supplied"]);
  // cre8-contracts#49 修正後：只有風險標記或停止才進「退出中」（不再存入）；利率跳動只暫停新存入、不擋領出。
  expect(STATE_LABEL.exiting.note).toContain("90% or more");
  expect(STATE_LABEL.exiting.note).toContain("stop lending");
  expect(STATE_LABEL.cash.note).toContain("does not stop withdrawals");
  expect(STATE_LABEL.supplied.note).toBeNull();
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("Waiting to come back: {money(row.pending.value)}.</strong> {pendingReasonText(row.pending.reason)}");
  expect(panel).toContain("Stop lending and withdraw everything");
  expect(panel).toContain("state.note !== null &&");
});

test("an old session needs a permission update, offered where the version update is (A10)", () => {
  const controls = fs.readFileSync("src/features/fund/AccountControls.tsx", "utf8");
  expect(controls).toContain("yieldPermission === 'needs_update'");
  expect(controls).toContain("Update permission");
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("yieldPermission={lending.view === 'ready' ? (lending.data?.permission ?? null) : null}");
  expect(page).toContain("onUpdatePermission={renewPermission}");
  expect(page).toContain("queryKey: ['portfolio-yield']");
});

test("the mock holder sample covers lent, not agreed and partly waiting, only on assets the fund holds", () => {
  const usdt = TESTNET_97.contracts.usdt;
  const eth = testnetToken("ETH")!;
  const sample = mockPortfolioYield([{ asset: usdt, symbol: "USDT" }, { asset: "0x0000000000000000000000000000000000000001", symbol: "X" }, { asset: eth, symbol: "ETH" }]);
  expect(sample.assets.map((item) => [item.symbol, item.state])).toEqual([["USDT", "supplied"], ["ETH", "not_consented"]]);
  expect(sample.permission).toBe("needs_update");
  expect(sample.accountValue).toBeNull();
});

test("with no yield on this chain the API answers null and the designer keeps Coming soon", async () => {
  const api = fs.readFileSync("src/lib/api.ts", "utf8");
  expect(api).toContain("if (cause instanceof ApiError && cause.status === 404) return null;");
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(designer).toContain('kind === "hold" && !lending ? featureLock("holdEarn") : null');
});
