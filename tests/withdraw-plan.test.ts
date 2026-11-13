import { expect, test } from "bun:test";
import { SELL_BUFFER, cashUsdOf, sellTargetUsd, totalUsdOf, withdrawShortfallNote } from "../src/lib/withdraw-plan";

// cre8-app#49：提領用頁面快取的現金判斷，資料舊時完全不賣出、只轉出現金，還說成「沒有可賣的部位」。
// A3 的實測數字：USDT 10 / DOGE 90 的基金存 400，排程器分三批買完後帳戶是 USDT 39.66、DOGE 約 $356；
// 頁面還停在剛存款時（現金 400）。使用者要提 250。

const e8 = (usd: number) => String(Math.round(usd * 1e8));
const stale = [{ symbol: "USDT", usdValueE8: e8(400) }];
const fresh = [{ symbol: "USDT", usdValueE8: e8(39.66) }, { symbol: "DOGE", usdValueE8: e8(356.2) }];

test("cash comes from the numeraire row of the status that was just read", () => {
  expect(cashUsdOf(fresh, "USDT")).toBeCloseTo(39.66, 6);
  expect(cashUsdOf(stale, "USDT")).toBe(400);
  // 沒有現金那一列、或數字讀不出來：當 0（寧可多賣一輪，不要以為現金夠）。
  expect(cashUsdOf([{ symbol: "DOGE", usdValueE8: e8(10) }], "USDT")).toBe(0);
  expect(cashUsdOf([{ symbol: "USDT", usdValueE8: "not a number" }], "USDT")).toBe(0);
  expect(cashUsdOf([], "USDT")).toBe(0);
});

test("the fund total reads as dollars, and as zero when unknown", () => {
  expect(totalUsdOf(e8(395.86))).toBeCloseTo(395.86, 6);
  expect(totalUsdOf(null)).toBe(0);
  expect(totalUsdOf(undefined)).toBe(0);
  expect(totalUsdOf("abc")).toBe(0);
});

test("with fresh cash the shortfall is sold; with the stale number nothing would be", () => {
  // 這就是 bug：拿舊的現金（400）算，缺口是負的 → 不賣。
  expect(sellTargetUsd(250, cashUsdOf(stale, "USDT"))).toBeNull();
  // 拿剛讀到的現金（39.66）算，缺口 210.34，放大 1/(1−6%) 後請後端賣約 223.77。
  const target = sellTargetUsd(250, cashUsdOf(fresh, "USDT"));
  expect(target).not.toBeNull();
  expect(target as number).toBeCloseTo(210.34 / (1 - SELL_BUFFER), 5);
  expect(target as number).toBeGreaterThan(210.34);
});

test("no sale when cash already covers the amount, give or take a cent", () => {
  expect(sellTargetUsd(20, 39.66)).toBeNull();
  expect(sellTargetUsd(39.66, 39.66)).toBeNull();
  expect(sellTargetUsd(39.665, 39.66)).toBeNull();
  expect(sellTargetUsd(39.68, 39.66)).not.toBeNull();
  // 現金 0：整筆都要賣。
  expect(sellTargetUsd(100, 0)).toBeCloseTo(100 / (1 - SELL_BUFFER), 5);
});

test("no note when everything asked for was sent", () => {
  expect(withdrawShortfallNote({ sentUsd: 250, askedUsd: 250, holdings: fresh, cashSymbol: "USDT" })).toBeNull();
  expect(withdrawShortfallNote({ sentUsd: 249.995, askedUsd: 250, holdings: fresh, cashSymbol: "USDT" })).toBeNull();
});

test("'no positions left' is only said when there really are none", () => {
  // 部位真的賣光了（只剩渣）。
  const empty = [{ symbol: "USDT", usdValueE8: e8(0) }, { symbol: "DOGE", usdValueE8: e8(0.3) }];
  expect(withdrawShortfallNote({ sentUsd: 49.75, askedUsd: 50, holdings: empty, cashSymbol: "USDT" })).toBe(
    "Sent $49.75 of the $50.00 you asked for — the account has no positions left to sell.",
  );
  // A3 看到的錯誤情境：還有 $356 的 DOGE，卻只轉出 39.66。不可以說成沒有部位。
  const note = withdrawShortfallNote({ sentUsd: 39.66, askedUsd: 250, holdings: fresh, cashSymbol: "USDT" });
  expect(note).toBe(
    "Sent $39.66 of the $250.00 you asked for — the remaining $210.34 could not be sold right now. Your positions are still in the fund; you can try again.",
  );
  expect(note).not.toContain("no positions left");
});

test("when positions remain, the backend's reason is passed on", () => {
  expect(
    withdrawShortfallNote({ sentUsd: 150, askedUsd: 250, holdings: fresh, cashSymbol: "USDT", reason: " 單筆上限 150 USDT " }),
  ).toBe(
    "Sent $150.00 of the $250.00 you asked for — the remaining $100.00 could not be sold right now (單筆上限 150 USDT). Your positions are still in the fund; you can try again.",
  );
  // 原因是空的就不加括號。
  expect(withdrawShortfallNote({ sentUsd: 150, askedUsd: 250, holdings: fresh, cashSymbol: "USDT", reason: "  " })).not.toContain("()");
});

test("a holding whose value cannot be read counts as a position, not as 'nothing left'", () => {
  const unknown = [{ symbol: "USDT", usdValueE8: e8(0) }, { symbol: "DOGE", usdValueE8: "?" }];
  expect(withdrawShortfallNote({ sentUsd: 10, askedUsd: 50, holdings: unknown, cashSymbol: "USDT" })).toContain("could not be sold right now");
});
