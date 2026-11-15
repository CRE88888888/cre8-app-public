import { expect, test } from "bun:test";
import { MOCK_FUNDS } from "../src/data/mock-funds";
import { MAINNET_STATUS } from "../src/lib/testnet-assets";
import { activationDesign } from "../src/lib/activation-design";
import { LAUNCH_ASSETS } from "../src/lib/launch-admission";
import { INVESTABLE_FUND_SLUGS, fundLaunchStatus, investableFundSlugs } from "../src/lib/launch-funds";
import { TESTNET_97 } from "../src/lib/testnet-97";
import { IS_TESTNET, TESTNET_LISTED_SLUGS, isListedFund, isTestnetSymbol, listedFunds, testnetToken } from "../src/lib/testnet-catalogue";
import * as B from "../src/reference/lib/fund-builder";

// cre8-app#86：測試網只展示 16 檔、資產用 cre8-contracts#43 的 92 個；主網不變。

test("the 16 listed funds all exist in the catalogue, once each", () => {
  expect(TESTNET_LISTED_SLUGS.length).toBe(16);
  expect(new Set(TESTNET_LISTED_SLUGS).size).toBe(16);
  const slugs = new Set(MOCK_FUNDS.map((fund) => fund.slug));
  for (const slug of TESTNET_LISTED_SLUGS) expect(slugs.has(slug)).toBe(true);
});

test("testnet lists 16 funds; mainnet still lists all of them", () => {
  expect(listedFunds(MOCK_FUNDS, true).map((fund) => fund.slug).sort()).toEqual([...TESTNET_LISTED_SLUGS].sort());
  expect(listedFunds(MOCK_FUNDS, false).length).toBe(MOCK_FUNDS.length);
  expect(isListedFund("elon-universe", true)).toBe(false);
  expect(isListedFund("elon-universe", false)).toBe(true);
});

test("on testnet all 16 are open to invest and the other 14 are not", () => {
  expect(investableFundSlugs(true).sort()).toEqual([...TESTNET_LISTED_SLUGS].sort());
  for (const slug of TESTNET_LISTED_SLUGS) expect(fundLaunchStatus(slug, true)).toEqual({ status: "open", missing: [] });
  // 沒列出的基金：就算成分全在 92 個裡，直接打網址進去也不能投資。
  expect(fundLaunchStatus("elon-universe", true)?.status).toBe("preview");
});

test("mainnet behaviour is unchanged: 38 assets and the same 5 open funds", () => {
  expect(LAUNCH_ASSETS.filter((asset) => asset.symbol !== "USDT").length).toBe(38);
  expect(INVESTABLE_FUND_SLUGS).toEqual(["mag7", "elon-universe", "raoul-pal-x", "ming-chi-kuo-x", "lyn-alden-x"]);
  expect(investableFundSlugs(false)).toEqual([...INVESTABLE_FUND_SLUGS]);
});

test("the 14 new cryptos are on testnet, matched whatever the letter case", () => {
  for (const symbol of ["ADA", "LINK", "BCH", "NEAR", "UNI", "ZEC", "TONCOIN", "DOT", "SHIB", "PEPE", "AAVE", "CAKE", "FIL", "ATOM"]) {
    expect(isTestnetSymbol(symbol)).toBe(true);
  }
  expect(isTestnetSymbol("usdt")).toBe(true);
  expect(isTestnetSymbol("NOPE")).toBe(false);
  expect(testnetToken("btcb")).toBe(TESTNET_97.assets.BTCB);
});

test("on testnet the designer offers the catalogue assets that testnet has, new cryptos included", () => {
  const offered = B.ASSETS.filter((asset) => B.canPickAsset(asset) && isTestnetSymbol(asset.symbol)).map((asset) => asset.symbol);
  for (const symbol of ["ADA", "LINK", "BCH", "NEAR", "UNI", "BTCB", "NVDAB", "XAUt"]) expect(offered).toContain(symbol);
  expect(new Set(offered.map((symbol) => symbol.toLowerCase())).size).toBe(offered.length);
});

test("the 8 cryptos CRE8 added to the designer catalogue are there, testnet-listed and only plannable on mainnet", () => {
  // cre8-app#86 的本地例外（src/reference/lib/fund-builder.ts 的 CRE8_TESTNET_CRYPTO）：同步上游時若被覆蓋，這裡會失敗。
  const added = ["TONCOIN", "DOT", "SHIB", "PEPE", "AAVE", "CAKE", "FIL", "ATOM"];
  for (const symbol of added) {
    const asset = B.ASSETS.find((candidate) => candidate.symbol === symbol);
    expect(asset?.category).toBe("crypto");
    // 主網只能規劃（preview）；測試網的 build 載入時改成 ready（lib/testnet-assets.ts）。
    expect(MAINNET_STATUS.get(asset!.key)).toBe("preview");
    expect(asset?.status).toBe(IS_TESTNET ? "ready" : "preview");
    expect(B.canPickAsset(asset!)).toBe(true);
    expect(isTestnetSymbol(symbol)).toBe(true);
    // 主網仍不在 38 個准入資產裡。
    expect(LAUNCH_ASSETS.some((launch) => launch.symbol.toLowerCase() === symbol.toLowerCase())).toBe(false);
  }
  // 主網的 status 下 91 個可選（ZEC 沒有價格來源）；測試網的 build 打開 ZEC，92 個（cre8-app#93：明確指定鏈）。
  const mainnet = B.ASSETS.map((asset) => ({ ...asset, status: MAINNET_STATUS.get(asset.key) ?? asset.status }));
  expect(mainnet.filter((asset) => B.canPickAsset(asset) && isTestnetSymbol(asset.symbol)).length).toBe(91);
  expect(B.ASSETS.filter((asset) => B.canPickAsset(asset) && isTestnetSymbol(asset.symbol)).length).toBe(IS_TESTNET ? 92 : 91);
  // 加得進設計（只能用 Buy & hold，跟其他 preview 資產一樣）。
  const design = B.addAsset(B.emptyBuilder(), "CAKE", "demo");
  expect(design.rows.map((row) => row.key)).toEqual(["CAKE"]);
});

test("a design moves to the activation page with testnet token addresses on testnet", () => {
  const design = { ...B.addAsset(B.emptyBuilder(), "BTC", "demo"), name: "Test" };
  const testnet = activationDesign(design, true)!;
  const mainnet = activationDesign(design, false)!;
  const btc = TESTNET_97.assets.BTCB.toLowerCase();
  expect(testnet.weights[btc]).toBeGreaterThan(0);
  expect(testnet.symbols[btc]).toBe("BTCB");
  expect(mainnet.weights["0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c"]).toBe(testnet.weights[btc]);
  // 沒有放進資產的部分是 USDT：測試網要換成測試 USDT 的地址。
  const cash = Object.entries(testnet.symbols).find(([, symbol]) => symbol === "USDT");
  if (cash) expect(cash[0]).toBe(TESTNET_97.contracts.usdt.toLowerCase());
});
