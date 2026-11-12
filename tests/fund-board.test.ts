import { test, expect } from "bun:test";
import { REFERENCE_FUNDS } from "../src/lib/public-funds";
import { fundHoldings, longestHistory } from "../src/features/vaults/FundBoard";

test("board holdings are sorted, sum to 100 and use underlying tickers", () => {
  for (const fund of REFERENCE_FUNDS) {
    const holdings = fundHoldings(fund);
    expect(holdings.length).toBeGreaterThan(0);
    const total = holdings.reduce((sum, row) => sum + row.weight, 0);
    expect(Math.abs(total - 100)).toBeLessThan(1e-6);
    for (let i = 1; i < holdings.length; i++)
      expect(holdings[i - 1].weight).toBeGreaterThanOrEqual(holdings[i].weight);
  }
  const ai = fundHoldings(REFERENCE_FUNDS.find((fund) => fund.slug === "ai-buildout")!);
  // 鏈上代幣符號（NVDAB）在榜上顯示成底層代號（NVDA）。
  expect(ai.map((row) => row.label)).toContain("NVDA");
  expect(ai.map((row) => row.label)).not.toContain("NVDAB");
});

test("a fund with no positions yields no holdings instead of NaN weights", () => {
  const empty = { ...REFERENCE_FUNDS[0], positions: [] };
  expect(fundHoldings(empty)).toEqual([]);
});

test("longest history is the baseline for flagging shorter track records", () => {
  const longest = longestHistory(REFERENCE_FUNDS, "1Y");
  expect(longest).toBeGreaterThan(200);
  expect(longestHistory([], "1Y")).toBe(0);
});
