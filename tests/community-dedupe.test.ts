import { expect, test } from "bun:test";
import fs from "node:fs";
import { catalogueStrategy, catalogueTwin } from "../src/lib/community-fund";

// 使用者 2026-11-20（首發 21 檔）：後端基金用 `catalogKey` 對應參考目錄，不用名稱比對。

test("a backend fund maps to the catalogue by catalogKey, never by name", () => {
  expect(catalogueTwin("mag7")?.name).toBe("Mag7");
  expect(catalogueTwin(null)).toBeUndefined();
  expect(catalogueTwin(undefined)).toBeUndefined();
  expect(catalogueTwin("")).toBeUndefined();
  expect(catalogueTwin("not-in-the-catalogue")).toBeUndefined();
  const vaults = fs.readFileSync("src/features/vaults/VaultsPage.tsx", "utf8");
  expect(vaults).toContain("catalogKey: strategy.catalogKey,");
  expect(vaults).not.toContain("LISTED_FUNDS");
});

test("a catalogue page finds its backend fund by catalogKey; name only for rows without one", () => {
  const mag7 = { id: 20, name: "Mag7", catalogKey: "mag7" };
  const old = { id: 19, name: "Pelosi Disclosed Equity", catalogKey: null };
  const sameNameNewFund = { id: 40, name: "Pelosi Disclosed Equity", catalogKey: "pelosi-2026" };
  expect(catalogueStrategy([mag7], "mag7", "Mag7")).toBe(mag7);
  // 後端還沒填 catalogKey（部署前的舊資料）：退回同名。
  expect(catalogueStrategy([old], "pelosi-disclosed-equity", "Pelosi Disclosed Equity")).toBe(old);
  // 有 catalogKey 的新基金不會因為同名被當成目錄那一檔。
  expect(catalogueStrategy([sameNameNewFund], "pelosi-disclosed-equity", "Pelosi Disclosed Equity")).toBeUndefined();
  // 後端隱藏了（不在公開列表）＝下架。
  expect(catalogueStrategy([mag7], "pelosi-disclosed-equity", "Pelosi Disclosed Equity")).toBeUndefined();
});

test("an old catalogue link shows a delisted state instead of the trading page", () => {
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("catalogueStrategy(listed.data, catalogue.slug, catalogue.name) === undefined");
  expect(page).toContain("return <DelistedFund name={catalogue.name} />;");
  expect(page).toContain("is no longer listed</h2>");
  // 持有的人從 Portfolio 用策略 id 進基金頁，不會被下架頁擋住。
  const portfolios = fs.readFileSync("src/features/portfolios/PortfoliosPage.tsx", "utf8");
  expect(portfolios).toContain("`/funds/strategy/${strategyId}?position=1&returnTo=%2Fportfolios`");
});
