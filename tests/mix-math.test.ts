import { expect, test } from "bun:test";
import {
  MIN_WEIGHT_BPS, TOTAL_BPS, defaultMixName, equalWeights, formatPctString, formatReturnBps, formatUsdt, maxWeight,
  parseUsdtInput, setWeight, stepWeight, untilLabel, weightLabel,
} from "../src/features/mix/mix-math";
import { MIX_CATALOG, POPULAR, mixAsset, searchMixAssets } from "../src/features/mix/mix-catalog";

// My mix（cre8-app#132）：用戶不可能看到「比例加總不對」，所以每一種調法總和都要剛好 100%。

const sum = (weights: number[]) => weights.reduce((a, b) => a + b, 0);

test("an even split always adds up to 100%", () => {
  for (let n = 1; n <= 10; n += 1) {
    const weights = equalWeights(n);
    expect(weights.length).toBe(n);
    expect(sum(weights)).toBe(TOTAL_BPS);
    expect(Math.max(...weights) - Math.min(...weights)).toBeLessThanOrEqual(1);
  }
  expect(equalWeights(3)).toEqual([3334, 3333, 3333]);
});

test("+ and − move one pick by 5% and the others follow in proportion", () => {
  const up = stepWeight([2500, 2500, 2500, 2500], 0, 1);
  expect(up[0]).toBe(3000);
  expect(sum(up)).toBe(TOTAL_BPS);
  // 其他三個原本一樣大，所以一起變小、仍然一樣大（零頭最多差 1）。
  expect(Math.max(...up.slice(1)) - Math.min(...up.slice(1))).toBeLessThanOrEqual(1);

  const lopsided = setWeight([6000, 3000, 1000], 0, 5000);
  expect(lopsided[0]).toBe(5000);
  expect(sum(lopsided)).toBe(TOTAL_BPS);
  // 多出來的 10% 照原比例（扣掉最低 5% 後 2500:500）分給另外兩個。
  expect(lopsided[1]! > lopsided[2]!).toBe(true);
});

test("no pick drops below 5% or goes past what the others leave", () => {
  for (let n = 2; n <= 10; n += 1) {
    let weights = equalWeights(n);
    for (let i = 0; i < 40; i += 1) {
      weights = stepWeight(weights, i % n, i % 3 === 0 ? -1 : 1);
      expect(sum(weights)).toBe(TOTAL_BPS);
      expect(Math.min(...weights)).toBeGreaterThanOrEqual(MIN_WEIGHT_BPS);
      expect(Math.max(...weights)).toBeLessThanOrEqual(maxWeight(n));
    }
  }
  // 已經到頂再按 + 不會變。
  const top = setWeight([5000, 5000], 0, 9500);
  expect(top).toEqual([9500, 500]);
  expect(stepWeight(top, 0, 1)).toEqual([9500, 500]);
  expect(stepWeight(top, 1, -1)).toEqual([9500, 500]);
});

test("one pick is always 100%", () => {
  expect(setWeight([10000], 0, 3000)).toEqual([10000]);
  expect(stepWeight([10000], 0, -1)).toEqual([10000]);
});

test("percent labels stay short", () => {
  expect(weightLabel(2500)).toBe("25%");
  expect(weightLabel(3334)).toBe("33.3%");
  expect(weightLabel(10000)).toBe("100%");
});

test("the automatic name uses the tickers people know", () => {
  expect(defaultMixName(["NVDAB"])).toBe("NVDA");
  expect(defaultMixName(["NVDAB", "BTCB"])).toBe("NVDA + BTC");
  expect(defaultMixName(["NVDAB", "TSLAB", "BTCB", "WBNB"])).toBe("NVDA + TSLA + 2 more");
  expect(defaultMixName([])).toBe("My mix");
});

test("amounts are read and shown as people type them", () => {
  const unit = 10n ** 18n;
  expect(parseUsdtInput("1,000")).toBe(1000n * unit);
  expect(parseUsdtInput("50.5")).toBe(50n * unit + unit / 2n);
  expect(parseUsdtInput("")).toBeNull();
  expect(parseUsdtInput("abc")).toBeNull();
  expect(parseUsdtInput("1.2.3")).toBeNull();
  expect(formatUsdt(1300n * unit)).toBe("1,300");
  expect(formatUsdt(1184n * unit + unit / 5n)).toBe("1,184.20");
  expect(formatUsdt(-(12n * unit))).toBe("-12");
});

test("returns read like a person would say them", () => {
  expect(formatReturnBps("3000")).toBe("+30%");
  expect(formatReturnBps("1842")).toBe("+18.4%");
  expect(formatReturnBps("-450")).toBe("−4.5%");
  expect(formatReturnBps("0")).toBe("0%");
  expect(formatReturnBps(null)).toBeNull();
  expect(formatPctString("23.41000000")).toBe("+23%");
  expect(formatPctString("-9.6")).toBe("−10%");
  expect(formatPctString(null)).toBeNull();
});

test("time to the next open is a short phrase", () => {
  const now = new Date("2026-11-21T09:30:00Z");
  expect(untilLabel("2026-11-21T14:30:00Z", now)).toBe("5h");
  expect(untilLabel("2026-11-21T10:10:00Z", now)).toBe("40m");
  expect(untilLabel("2026-11-24T14:30:00Z", now)).toBe("3d");
  expect(untilLabel("2026-11-20T14:30:00Z", now)).toBe("a moment");
});

test("the catalogue is the 40 assets the backend accepts for a mix", () => {
  // 與後端 src/model-returns/assets.json（MIX_ASSETS）同一份；XAUt 在 App 地址簿裡是 XAUt。
  const backend = "AAPLB AMCB AMZNB ANTB AVGOB BABAB BMNRB BNCB BTCB COINB CRCLB CYPHB DJTB DOGE EWYB GMEB GOOGLB HOODB INTCB METAB MRVLB MSFTB MSTRB MUB NFLXB NVDAB PDDB PENGB QQQB RDDTB SKHYB SNDKB SOXLB SPCXB SPYB TQQQB TSLAB TSMB WBNB XAUT".split(" ");
  expect(MIX_CATALOG.map((a) => a.symbol.toUpperCase()).sort()).toEqual(backend.sort());
  expect(new Set(MIX_CATALOG.map((a) => a.address)).size).toBe(40);
  for (const symbol of POPULAR) expect(mixAsset(symbol)).toBeDefined();
  // 槓桿 ETF 標 Risky，其他不標。
  expect(MIX_CATALOG.filter((a) => a.risky).map((a) => a.ticker).sort()).toEqual(["SOXL", "TQQQ"]);
});

test("search finds a ticker or a company name", () => {
  expect(searchMixAssets("nvda").map((a) => a.ticker)).toEqual(["NVDA"]);
  expect(searchMixAssets("tesla").map((a) => a.ticker)).toEqual(["TSLA"]);
  expect(searchMixAssets("BITCOIN").map((a) => a.ticker)).toContain("BTC");
  expect(searchMixAssets("  ").length).toBe(40);
  expect(searchMixAssets("zzz")).toEqual([]);
});
