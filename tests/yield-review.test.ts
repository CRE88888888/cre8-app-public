import { expect, test } from "bun:test";
import fs from "node:fs";
import { exportDesign } from "../src/lib/design-export";
import { TESTNET_97 } from "../src/lib/testnet-97";
import {
  CASH_PICK,
  YIELD_BATCH_MARKETS,
  YieldBookMismatch,
  YieldStateChanged,
  cashLendingOptions,
  checkYieldBook,
  checkYieldSigning,
  consentable,
  lendingChoicesText,
  recheckBeforeSigning,
  yieldBatches,
  yieldListBlock,
  yieldRefreshMs,
  yieldViewState,
  type AssetYield,
  type YieldMarket,
  type YieldMarketList,
} from "../src/lib/yield";
import { yieldBookFor } from "../src/lib/yield-book";
import { MOCK_MARKETS_97 } from "../src/lib/yield-mock";
import { pendingKey, readPendingRecords, removePendingRecord, savePendingRecord } from "../src/lib/yield-pending";

// cre8-app#95 部署前審查（rv-yield-app）的 13 項：第 3 項在 backend#112 修，其餘每項一個測試。

const BOOK = yieldBookFor(97)!;
const venusUsdt = MOCK_MARKETS_97.markets.find((m) => m.id === "venus_usdt")!;
const listaUsdt = MOCK_MARKETS_97.markets.find((m) => m.id === "lista_usdt")!;

const row = (over: Partial<AssetYield> = {}): AssetYield => ({
  asset: venusUsdt.asset,
  symbol: "USDT",
  market: "venus_usdt",
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

const listOf = (markets: YieldMarket[], over: Partial<YieldMarketList> = {}): YieldMarketList => ({
  chainId: 97,
  registry: TESTNET_97.contracts.yieldRegistry.toLowerCase(),
  markets,
  ...over,
});

test("#1 the market list must match the address book: slug, protocol, asset, receipt and marketId together, and the registry", () => {
  expect(BOOK.markets).toHaveLength(30);
  expect(BOOK.registry).toBe(TESTNET_97.contracts.yieldRegistry.toLowerCase());
  expect(BOOK.executor).toBe(TESTNET_97.contracts.executor.toLowerCase());
  expect(checkYieldBook(MOCK_MARKETS_97, BOOK)).toBe(MOCK_MARKETS_97);
  // 審查的 PoC：標籤留 venus_usdt，receipt／marketId 換成 Lista 的 → 停。
  const swapped = { ...venusUsdt, receipt: listaUsdt.receipt, marketId: listaUsdt.marketId };
  expect(() => checkYieldBook(listOf([swapped]), BOOK)).toThrow(YieldBookMismatch);
  expect(() => checkYieldBook(listOf([{ ...venusUsdt, protocol: "lista" }]), BOOK)).toThrow(YieldBookMismatch);
  expect(() => checkYieldBook(listOf([{ ...venusUsdt, asset: listaUsdt.receipt }]), BOOK)).toThrow(YieldBookMismatch);
  expect(() => checkYieldBook(listOf([{ ...venusUsdt, id: "venus_usdx" }]), BOOK)).toThrow(YieldBookMismatch);
  expect(() => checkYieldBook(listOf([venusUsdt], { registry: TESTNET_97.contracts.registry.toLowerCase() }), BOOK)).toThrow(YieldBookMismatch);
  // APR 是動態資料，照 API。
  expect(checkYieldBook(listOf([{ ...venusUsdt, aprBps: 9_999 }]), BOOK).markets[0]!.aprBps).toBe(9_999);
  // 簽名前：executor 與 registry 也要等於地址簿。
  const good = { chainId: 97, executor: TESTNET_97.contracts.executor, registry: TESTNET_97.contracts.yieldRegistry, markets: [venusUsdt], rows: [row()] };
  expect(() => checkYieldSigning(good, BOOK)).not.toThrow();
  expect(() => checkYieldSigning({ ...good, executor: TESTNET_97.contracts.router }, BOOK)).toThrow(YieldBookMismatch);
  expect(() => checkYieldSigning({ ...good, markets: [swapped] }, BOOK)).toThrow(YieldBookMismatch);
  expect(fs.readFileSync("src/lib/yield-flow.ts", "utf8")).toContain("checkYieldSigning(");
  const api = fs.readFileSync("src/lib/api.ts", "utf8");
  expect(api).toContain("checkYieldBook(");
});

test("#2 lending only exists on chain 97: no book elsewhere, the list is not fetched, the panel and signing are guarded, and the reply's chainId must match", async () => {
  expect(yieldBookFor(56)).toBeNull();
  expect(yieldBookFor(31337)).toBeNull();
  expect(() => checkYieldSigning({ chainId: 56, executor: TESTNET_97.contracts.executor, registry: TESTNET_97.contracts.yieldRegistry, markets: [venusUsdt], rows: [row()] }, null)).toThrow(YieldBookMismatch);
  expect(() => checkYieldBook(listOf([venusUsdt], { chainId: 56 }), BOOK)).toThrow(YieldBookMismatch);
  const api = fs.readFileSync("src/lib/api.ts", "utf8");
  expect(api).toContain("const book = yieldBookFor(chainId);");
  expect(api).toContain("if (book === null) return null;");
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("yieldBookFor(CHAIN.id) === null");
  // 主網 build 拿到 chain 97 的回應：取得清單就回 null，不發請求。
  const { getYieldMarkets } = await import("../src/lib/api");
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => { called += 1; return new Response(JSON.stringify(MOCK_MARKETS_97), { status: 200 }); }) as unknown as typeof fetch;
  try {
    expect(await getYieldMarkets(56)).toBeNull();
    expect(called).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});

test("#4 at most 16 markets per signature: 17 markets go out as 16 + 1, in order", () => {
  expect(YIELD_BATCH_MARKETS).toBe(16);
  const items = Array.from({ length: 17 }, (_, i) => i);
  expect(yieldBatches(items)).toEqual([items.slice(0, 16), items.slice(16)]);
  expect(yieldBatches([])).toEqual([]);
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(fs.readFileSync("src/lib/yield-flow.ts", "utf8")).toContain("yieldBatches(");
  expect(panel).toContain("Not sent yet:");
});

test("#5 a signature that landed but was not recorded is kept per chain, account and portfolio, and can be sent again with the same txHash", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const key = pendingKey(97, "0xABCDEF0000000000000000000000000000000001", 7);
  expect(key).toBe("cre8.yield.unrecorded.v2.97.0xabcdef0000000000000000000000000000000001.7");
  expect(pendingKey(97, "0xabcdef0000000000000000000000000000000001", 8)).not.toBe(key);
  const record = { kind: "consent" as const, markets: ["venus_usdt"], userOpHash: `0x${"cd".repeat(32)}`, txHash: `0x${"ab".repeat(32)}`, state: "confirmed" as const };
  savePendingRecord(storage, key, record);
  savePendingRecord(storage, key, record);
  expect(readPendingRecords(storage, key)).toEqual([record]);
  expect(JSON.parse(store.get(key)!)).toEqual([record]);
  removePendingRecord(storage, key, record.userOpHash);
  expect(readPendingRecords(storage, key)).toEqual([]);
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("Send the record again");
  // 原 API 錯誤（code／status）原樣丟出，不包成普通 Error。
  const flow = fs.readFileSync("src/lib/yield-flow.ts", "utf8");
  expect(flow).toContain("throw lastError;");
  expect(panel).not.toContain("but the server did not record it yet: ` +");
});

test("#6 a draft with lending picks cannot be created until the market list has loaded", () => {
  expect(yieldListBlock(1, { data: undefined, isError: false })).toBe("loading");
  expect(yieldListBlock(1, { data: undefined, isError: true })).toBe("error");
  expect(yieldListBlock(0, { data: undefined, isError: true })).toBeNull();
  expect(yieldListBlock(2, { data: MOCK_MARKETS_97, isError: false })).toBeNull();
  // 有快取但重抓失敗：也不能用。
  expect(yieldListBlock(1, { data: MOCK_MARKETS_97, isError: true })).toBe("error");
  const page = fs.readFileSync("src/features/create/CreateFundPage.tsx", "utf8");
  expect(page).toContain("yieldBlock === null");
  expect(page).toContain("Loading lending markets");
  expect(page).toContain("Retry");
});

test("#7 lending has four states: off, loading, error (unknown + retry, no signing) and ready", () => {
  const ok = { data: MOCK_MARKETS_97, isError: false, isPending: false };
  const status = (over = {}) => ({ data: { permission: "ok" as const, accountValue: null, assets: [row()] }, isError: false, isPending: false, ...over });
  expect(yieldViewState({ chainHasYield: false, markets: ok, status: status() })).toBe("off");
  expect(yieldViewState({ chainHasYield: true, markets: { data: null, isError: false, isPending: false }, status: status() })).toBe("off");
  expect(yieldViewState({ chainHasYield: true, markets: { data: undefined, isError: false, isPending: true }, status: status({ data: undefined, isPending: true }) })).toBe("loading");
  expect(yieldViewState({ chainHasYield: true, markets: { data: undefined, isError: true, isPending: false }, status: status({ data: undefined }) })).toBe("error");
  expect(yieldViewState({ chainHasYield: true, markets: ok, status: status({ isError: true }) })).toBe("error");
  expect(yieldViewState({ chainHasYield: true, markets: ok, status: status({ data: null }) })).toBe("off");
  expect(yieldViewState({ chainHasYield: true, markets: ok, status: status() })).toBe("ready");
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(panel).toContain("view === 'error'");
  expect(panel).toContain("Lending status could not be read");
});

test("#8 while withdrawing, the status refreshes; before signing the latest state is read again and a change stops the signature", () => {
  expect(yieldRefreshMs({ permission: "ok", accountValue: null, assets: [row({ state: "exiting" })] })).toBe(30_000);
  expect(yieldRefreshMs({ permission: "ok", accountValue: null, assets: [row({ state: "supplied" })] })).toBe(false);
  expect(yieldRefreshMs(null)).toBe(false);
  const markets = [venusUsdt, listaUsdt];
  const fresh = (assets: AssetYield[]) => ({ permission: "ok" as const, accountValue: null, assets });
  // 另一個分頁已經開始全部領回：不能再送同意。
  expect(() => recheckBeforeSigning("consent", ["venus_usdt"], fresh([row(), row({ market: "lista_usdt", state: "exiting" })]), markets)).toThrow(YieldStateChanged);
  expect(recheckBeforeSigning("consent", ["venus_usdt"], fresh([row()]), markets).map((r) => r.market)).toEqual(["venus_usdt"]);
  expect(() => recheckBeforeSigning("revoke", ["venus_usdt"], fresh([row({ state: "stopped" })]), markets)).toThrow(YieldStateChanged);
  expect(recheckBeforeSigning("exit", [], fresh([row({ state: "supplied" }), row({ market: "lista_usdt", state: "cash" })]), markets)).toHaveLength(2);
  const panel = fs.readFileSync("src/features/fund/YieldPanel.tsx", "utf8");
  expect(fs.readFileSync("src/lib/yield-flow.ts", "utf8")).toContain("recheckBeforeSigning(");
  expect(panel).toContain(">Refresh<");
});

test("#9 a picked cash market can be turned Off even when no cash market is open", () => {
  expect(cashLendingOptions([], "venus_usdt")).toEqual([["", "Off"], ["venus_usdt", "Closed market (venus_usdt)"]]);
  expect(cashLendingOptions([], null)).toEqual([["", "Off"]]);
  expect(cashLendingOptions([venusUsdt], "venus_usdt").map(([id]) => id)).toEqual(["", "venus_usdt"]);
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(designer).toContain("cash > 0 && (cashMarkets.length > 0 || picks[CASH_PICK] !== undefined)");
  // 現金是 0 時，看不到的現金選擇不擋啟用。
  expect(designer).toContain("...(cash > 0 ? [{ key: CASH_PICK");
});

test("#10 lent but consent cancelled can be agreed again directly, unless withdrawing everything", () => {
  const markets = [venusUsdt, listaUsdt];
  const cancelled = row({ state: "supplied", consented: false });
  expect(consentable([cancelled], markets)).toEqual([cancelled]);
  expect(consentable([row({ state: "supplied", consented: true })], markets)).toEqual([]);
  expect(consentable([row({ state: "supplied" })], markets)).toEqual([]);
  expect(consentable([cancelled, row({ market: "lista_usdt", state: "exiting" })], markets)).toEqual([]);
});

test("#11 removing an asset clears its lending pick", () => {
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(designer).toContain("prunePicks(readYieldPicks(s), B.assetKeys(next.rows))");
});

test("#12 the Lending income line reads the per-asset picks instead of saying None", () => {
  expect(lendingChoicesText([{ name: "BTC", market: venusUsdt }, { name: "Cash", market: listaUsdt }])).toBe("BTC on Venus · Cash on Lista");
  expect(lendingChoicesText([{ name: "BTC", market: undefined }])).toBe("BTC on unknown");
  expect(lendingChoicesText([])).toBeNull();
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(designer).toContain("lendingChoicesText(");
});

test("#13 Download design carries each asset's and the cash's lending market", () => {
  const design = { chainId: 56, assets: [{ asset: "btc", symbol: "BTC", token: "0x1" }, { asset: "eth", symbol: "ETH", token: "0x2" }], cash: { token: "USDT", shareBps: 1_000 } };
  const out = exportDesign(design, { chainId: 97, testnet: false, feePct: 10, yieldPicks: { btc: "venus_btcb", [CASH_PICK]: "venus_usdt" } }) as unknown as { assets: { yield: unknown }[]; cash: { yield: unknown } };
  expect(out.assets.map((a) => a.yield)).toEqual([{ market: "venus_btcb" }, null]);
  expect(out.cash.yield).toEqual({ market: "venus_usdt" });
  // 沒有任何選擇：匯出跟以前一樣（不加欄位）。
  const plain = exportDesign(design, { chainId: 56, testnet: false, feePct: 10, yieldPicks: {} }) as unknown as { assets: Record<string, unknown>[]; cash: Record<string, unknown> };
  expect("yield" in plain.assets[0]!).toBe(false);
  expect("yield" in plain.cash).toBe(false);
  const designer = fs.readFileSync("src/features/create/FundDesigner.tsx", "utf8");
  expect(designer).toContain("yieldPicks: prunePicks(picks, keys)");
});
