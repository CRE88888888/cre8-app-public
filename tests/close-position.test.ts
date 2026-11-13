import { expect, test } from "bun:test";
import {
  SWEEP_GAS_RESERVE_WEI,
  hasSellablePositions,
  lowerOf,
  sweepNativeWei,
} from "../src/lib/close-position";

const BNB = 10n ** 18n;

test("the native sweep is the current balance minus the gas reserve", () => {
  // cre8-app#23 的實測數字：頁面上的舊餘額 0.0311636，賣完之後鏈上只剩 0.0013423。
  const stale = 31_163_600_000_000_000n;
  const actual = 1_342_300_000_000_000n;
  const fromStale = sweepNativeWei(stale);
  const fromActual = sweepNativeWei(actual);
  expect(fromStale > actual).toBe(true); // 舊算法：掃出去的比餘額還多 → revert
  expect(fromActual).toBe(actual - SWEEP_GAS_RESERVE_WEI);
  expect(fromActual <= actual).toBe(true);
});

test("a balance at or below the reserve sweeps no native coin", () => {
  expect(sweepNativeWei(0n)).toBe(0n);
  expect(sweepNativeWei(SWEEP_GAS_RESERVE_WEI)).toBe(0n);
  expect(sweepNativeWei(SWEEP_GAS_RESERVE_WEI - 1n)).toBe(0n);
  expect(sweepNativeWei(SWEEP_GAS_RESERVE_WEI + 1n)).toBe(1n);
  expect(sweepNativeWei(BNB, 0n)).toBe(BNB);
});

test("positions worth selling are detected, cash is ignored", () => {
  const holdings = [
    { symbol: "USDT", usdValueE8: "2000000000" },
    { symbol: "BTCB", usdValueE8: "9000000000" },
    { symbol: "WBNB", usdValueE8: "9000000000" },
  ];
  expect(hasSellablePositions(holdings, "USDT")).toBe(true);
});

test("after a sell-out only cash and dust remain: nothing to sell, so a retry skips /close", () => {
  // 第一次 Close 已經賣完、掃回失敗：帳戶剩 284.75 USDT 與一點渣。
  const holdings = [
    { symbol: "USDT", usdValueE8: "28475000000" },
    { symbol: "BTCB", usdValueE8: "1200" },
    { symbol: "WBNB", usdValueE8: "0" },
  ];
  expect(hasSellablePositions(holdings, "USDT")).toBe(false);
  expect(hasSellablePositions([], "USDT")).toBe(false);
  expect(hasSellablePositions([{ symbol: "USDT", usdValueE8: "5000000000000" }], "USDT")).toBe(false);
});

test("dust that adds up to the floor counts as a position", () => {
  const dust = { symbol: "X", usdValueE8: "50000000" }; // $0.50
  expect(hasSellablePositions([dust], "USDT")).toBe(false);
  expect(hasSellablePositions([dust, { ...dust, symbol: "Y" }], "USDT")).toBe(true);
});

test("an unreadable value is treated as a position, not as dust", () => {
  expect(hasSellablePositions([{ symbol: "BTCB", usdValueE8: "n/a" }], "USDT")).toBe(true);
});

test("lowerOf picks the smaller reading", () => {
  expect(lowerOf(5n, 7n)).toBe(5n);
  expect(lowerOf(7n, 5n)).toBe(5n);
  expect(lowerOf(5n, 5n)).toBe(5n);
});
