import { expect, test } from "bun:test";
import { isAddress } from "viem";
import { MOCK_FUNDS } from "../src/data/mock-funds";
import {
  LAUNCH_ASSETS,
  POPULAR_ASSET_KEYS,
  isLaunchAsset,
  isLaunchSymbol,
  notOpenSymbols,
} from "../src/lib/launch-admission";
import { INVESTABLE_FUND_SLUGS, describeFundLaunch, fundLaunchStatus } from "../src/lib/launch-funds";
import * as B from "../src/reference/lib/fund-builder";

// cre8-app#51：上線時可上架的資產與可投資的展示基金（docs#32 的准入清單）。

test("the table holds the 38 admitted assets plus USDT, each once, with a valid address", () => {
  expect(LAUNCH_ASSETS.length).toBe(39);
  expect(LAUNCH_ASSETS.filter((asset) => asset.symbol !== "USDT").length).toBe(38);
  expect(new Set(LAUNCH_ASSETS.map((asset) => asset.symbol.toLowerCase())).size).toBe(39);
  expect(new Set(LAUNCH_ASSETS.map((asset) => asset.address.toLowerCase())).size).toBe(39);
  for (const asset of LAUNCH_ASSETS) {
    expect(isAddress(asset.address, { strict: false })).toBe(true);
    // 位址一律小寫，方便跟 docs 的 admission.json 逐行對。
    expect(asset.address).toBe(asset.address.toLowerCase());
  }
});

test("lookups work by address and by symbol, whatever the letter case", () => {
  expect(isLaunchAsset("0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c")).toBe(true); // BTCB
  expect(isLaunchAsset("0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c")).toBe(true);
  expect(isLaunchSymbol("BTCB")).toBe(true);
  expect(isLaunchSymbol("xaut")).toBe(true);
  expect(isLaunchSymbol("SGOVon")).toBe(true);
  expect(isLaunchSymbol("USDT")).toBe(true);
});

test("assets the review rejected, and assets it never covered, are not open", () => {
  // admission.json 裡 admitted = false 的五個。
  for (const symbol of ["ADA", "LINK", "MRVLB", "BCH", "NEAR"]) expect(isLaunchSymbol(symbol)).toBe(false);
  expect(isLaunchAsset("0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd")).toBe(false); // LINK
  expect(isLaunchAsset("0x3ee2200efb3400fabb9aacf31297cbdd1d435d47")).toBe(false); // ADA
  // 清單以外的資產。
  expect(isLaunchSymbol("AMDB")).toBe(false);
  expect(isLaunchSymbol("IEFon")).toBe(false);
  expect(isLaunchAsset("0xbf5140a22578168fd562dccf235e5d43a02ce9b1")).toBe(false); // UNI
  // 沒有值。
  expect(isLaunchAsset(undefined)).toBe(false);
  expect(isLaunchAsset(null)).toBe(false);
  expect(isLaunchAsset("")).toBe(false);
  expect(isLaunchSymbol(undefined)).toBe(false);
});

test("notOpenSymbols lists what keeps a fund from opening, once each, in order", () => {
  expect(notOpenSymbols([{ symbol: "BTCB" }, { symbol: "MSTRB" }, { symbol: "USDT" }])).toEqual([]);
  expect(notOpenSymbols([{ symbol: "BTCB" }, { symbol: "LINK" }, { symbol: "ADA" }, { symbol: "LINK" }])).toEqual(["LINK", "ADA"]);
  expect(notOpenSymbols([])).toEqual([]);
});

test("every Popular asset in the designer is on the launch list and can be picked", () => {
  expect(POPULAR_ASSET_KEYS.length).toBeGreaterThan(0);
  expect(new Set(POPULAR_ASSET_KEYS).size).toBe(POPULAR_ASSET_KEYS.length);
  for (const key of POPULAR_ASSET_KEYS) {
    const asset = B.ASSET_BY_KEY.get(key);
    expect(asset, `designer has no asset "${key}"`).toBeDefined();
    expect(B.canPickAsset(asset as B.Asset), `"${key}" cannot be picked in the designer`).toBe(true);
    expect(isLaunchAsset((asset as B.Asset).token), `"${key}" is not on the launch list`).toBe(true);
  }
});

test("every asset on the list (except USDT cash) exists in the designer, matched by token address", () => {
  const tokens = new Set(B.ASSETS.filter((asset) => B.canPickAsset(asset)).map((asset) => asset.token.toLowerCase()));
  const unmatched = LAUNCH_ASSETS.filter((asset) => asset.symbol !== "USDT" && !tokens.has(asset.address)).map((asset) => asset.symbol);
  expect(unmatched).toEqual([]);
  // 設計器裡現在可以選的資產數 = 清單上的 38 個。
  expect(B.ASSETS.filter((asset) => B.canPickAsset(asset) && isLaunchAsset(asset.token)).length).toBe(38);
});

test("exactly the five funds whose holdings are all on the list are investable", () => {
  // 主網的名單：明確指定鏈，`VITE_CHAIN_ID=97 bun test` 也要過（cre8-app#93）。
  // 與 docs#32 的結論一致：Mag7、Elon Universe、Raoul Pal、Ming-Chi Kuo（郭明錤）、Lyn Alden。
  // 這個測試失敗代表目錄資料或清單變了、可投資的名單跟著變了：確認是預期的再更新這裡。
  expect([...INVESTABLE_FUND_SLUGS].sort()).toEqual(["elon-universe", "lyn-alden-x", "mag7", "ming-chi-kuo-x", "raoul-pal-x"]);
  expect(MOCK_FUNDS.length).toBe(30);
  expect(MOCK_FUNDS.filter((fund) => fundLaunchStatus(fund.slug, false)?.status === "preview").length).toBe(25);
});

test("each showcase fund reports its status and what is missing", () => {
  expect(fundLaunchStatus("mag7", false)).toEqual({ status: "open", missing: [] });
  expect(fundLaunchStatus("lyn-alden-x", false)).toEqual({ status: "open", missing: [] });
  // 兩個成分在審查裡沒過。
  expect(fundLaunchStatus("crypto-leaders", false)).toEqual({ status: "preview", missing: ["ADA", "LINK"] });
  // 一個成分不在清單上。
  expect(fundLaunchStatus("treasury-reserve", false)).toEqual({ status: "preview", missing: ["IEFon"] });
  for (const fund of MOCK_FUNDS) {
    const result = fundLaunchStatus(fund.slug, false);
    expect(result).not.toBeNull();
    expect(result?.status === "open").toBe(result?.missing.length === 0);
  }
});

test("anything that is not a showcase fund has no launch status", () => {
  // Community 策略（/funds/strategy/:id）是真的上鏈的策略，不套這個標示。
  expect(fundLaunchStatus("strategy-12", false)).toBeNull();
  expect(fundLaunchStatus("")).toBeNull();
  expect(fundLaunchStatus(undefined)).toBeNull();
  expect(fundLaunchStatus(null)).toBeNull();
});

test("the fund page sentence says plainly whether the fund is open and what is missing", () => {
  expect(describeFundLaunch({ status: "open", missing: [] })).toBe("Open to invest. Every asset in this fund is available at launch.");
  expect(describeFundLaunch({ status: "preview", missing: ["IEFon"] }, (symbol) => symbol.replace(/on$/, ""))).toBe(
    "Preview only. This fund is not open for investment yet. One of its assets (IEF) is not available at launch.",
  );
  expect(describeFundLaunch({ status: "preview", missing: ["ADA", "LINK"] })).toBe(
    "Preview only. This fund is not open for investment yet. 2 of its assets (ADA, LINK) are not available at launch.",
  );
  // 缺很多個時只列前三個。
  expect(describeFundLaunch({ status: "preview", missing: ["A", "B", "C", "D", "E"] })).toBe(
    "Preview only. This fund is not open for investment yet. 5 of its assets (A, B, C and 2 more) are not available at launch.",
  );
  // 沒有成分的基金：不可投資，也沒有缺的東西可列。
  expect(describeFundLaunch({ status: "preview", missing: [] })).toBe("Preview only. This fund is not open for investment yet.");
});
