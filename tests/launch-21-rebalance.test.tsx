import { expect, test } from "bun:test";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PUBLIC_FUNDS } from "../src/data/public-fund-adapter";
import { FundSnapshot } from "../src/features/fund/FundSnapshot";
import { VersionNotice } from "../src/features/fund/VersionNotice";
import type { StrategyVersion } from "../src/lib/api";
import type { VersionSchedule } from "../src/lib/atp-contracts";
import {
  REBALANCE_COPY,
  REBALANCE_LABEL,
  SHOW_STACK_AND_YIELD,
  executionConfirm,
  parseRebalance,
  rebalanceText,
  versionRebalance,
} from "../src/lib/fund-execution";
import { LISTED_FUNDS } from "../src/lib/public-funds";

// 首發 21 檔（使用者 2026-11-20）：再平衡是「每月一次＋偏離超過 5% 也調」（backend#171 的 monthly_drift）；
// 策略只留再平衡，分批買入、生息、買法先不顯示。

test("monthly_drift is a known rebalance value; anything else is unknown, not a crash", () => {
  expect(parseRebalance("monthly_drift")).toBe("monthly_drift");
  for (const value of ["none", "monthly", "drift"]) expect(parseRebalance(value)).toBe(value);
  for (const value of ["source", "quarterly", "", 42, null, undefined, {}]) expect(parseRebalance(value)).toBeNull();
  expect(versionRebalance({ kind: "per_asset", rebalance: "monthly_drift", assets: [] })).toBe("monthly_drift");
  expect(versionRebalance({ kind: "per_asset", rebalance: "weekly" })).toBeNull();
  expect(versionRebalance(null)).toBeNull();
  expect(versionRebalance("monthly")).toBeNull();
});

test("the Rebalancing fact reads the backend version, and says — for a value it does not know", () => {
  expect(rebalanceText({ kind: "per_asset", rebalance: "monthly_drift" })).toBe("Monthly + on drift");
  expect(rebalanceText({ kind: "per_asset", rebalance: "drift" })).toBe("On allocation drift");
  expect(rebalanceText({ kind: "per_asset", rebalance: "quarterly" })).toBe("—");
  // 版本沒有 rebalance（舊後端、還沒讀到）：交給目錄的說法。
  expect(rebalanceText({ kind: "per_asset" })).toBeNull();
  expect(rebalanceText(undefined)).toBeNull();
  expect(REBALANCE_LABEL.monthly_drift).toBe("Monthly + on drift");
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("<dt>Rebalancing</dt><dd>{rebalanceText(factsVersion?.execution) ?? (reference?.sourceModel ? 'Source updates' : REBALANCE_LABEL[fund.rebalance] ?? '—')}</dd>");
});

test("copy for monthly_drift names both triggers", () => {
  expect(REBALANCE_COPY.monthly_drift.line).toMatch(/Once a month .* more than 5 points off/);
  expect(executionConfirm(new Set(["hold"]), "monthly_drift")).toMatch(/once a month, and when an asset is more than 5 points off its share, CRE8 sells and buys/);
});

test("the catalogue adapter keeps only known rebalance values", () => {
  const known = new Set(Object.keys(REBALANCE_LABEL));
  for (const fund of PUBLIC_FUNDS) expect(known.has(fund.rebalance)).toBe(true);
});

test("the snapshot under the Buy panel says monthly and on drift", () => {
  const base = LISTED_FUNDS[0]!;
  const fund = { ...base, backtest: { ...base.backtest, rebalance: "monthly_drift" } };
  const html = renderToStaticMarkup(<FundSnapshot fund={fund} />);
  expect(html).toContain("Rebalances monthly and when weights drift.");
});

test("stack amounts, yield and buy methods are hidden but the code stays", () => {
  expect(SHOW_STACK_AND_YIELD).toBe(false);
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("{SHOW_STACK_AND_YIELD && <StackBuyPreview");
  expect(page).toContain("{SHOW_STACK_AND_YIELD && holding !== undefined && (\n              <YieldPanel");
  expect(page).toContain("function StackBuyPreview(");
  expect(fs.existsSync("src/features/fund/YieldPanel.tsx")).toBe(true);
});

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const BTC = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const ZERO = `0x${"0".repeat(64)}`;
const later = Math.floor(Date.now() / 1000) + 20 * 3600;

test("a version notice lists weight changes but not buy-method changes", () => {
  const schedule: VersionSchedule = {
    registry: "0x7D39178401923140dF8b5A559a02682326F17350",
    strategyId: 5n,
    active: { version: 1, activeAt: 100, settingsHash: ZERO, performanceFeeBps: 0, assets: [{ asset: USDT, weightBps: 4_000 }, { asset: BTC, weightBps: 6_000 }] },
    // settingsHash 不同才會比對逐資產買法。
    pending: { version: 2, activeAt: later, settingsHash: `0x${"1".repeat(64)}`, performanceFeeBps: 0, assets: [{ asset: USDT, weightBps: 1_000 }, { asset: BTC, weightBps: 9_000 }] },
    lastPublishedAt: Math.floor(Date.now() / 1000) - 3600,
    historicalAssets: [USDT, BTC],
  };
  const version = (n: number, at: number, kind: "hold" | "stack"): StrategyVersion => ({
    strategyId: 5,
    version: n,
    allocation: { assets: [] },
    schedule: { kind: "interval", intervalSeconds: 3600 },
    execution: { kind: "per_asset", rebalance: "monthly_drift", assets: [{ asset: BTC, execution: kind === "stack" ? { kind, every: "weekly", slices: 8 } : { kind } }] },
    changeLog: null,
    activeAt: new Date(at * 1000).toISOString(),
    createdAt: new Date(0).toISOString(),
  });
  const symbolOf = (asset: string) => (asset.toLowerCase() === BTC ? "BTCB" : "USDT");
  const html = renderToStaticMarkup(
    <VersionNotice schedule={schedule} versions={[version(2, later, "hold"), version(1, 100, "stack")]} symbolOf={symbolOf} onExit={null} creator={null} />,
  );
  expect(html).toContain("BTCB: 60% → 90%");
  expect(html).not.toContain("Stack");
  expect(html).not.toContain("Buy &amp; hold");
  expect(html).not.toContain("How assets are bought");
});

test("the fund list groups by backend category: Themes, People, Leveraged, then the rest", async () => {
  const { groupFunds, groupOf } = await import("../src/lib/fund-categories");
  const items = [
    { id: 1, category: "leveraged" },
    { id: 2, category: null },
    { id: 3, category: "person" },
    { id: 4, category: "theme" },
    { id: 5, category: "something-new" },
    { id: 6 },
    { id: 7, category: "theme" },
  ];
  const groups = groupFunds(items);
  expect(groups.map((group) => group.name)).toEqual(["Themes", "People", "Leveraged", "Other funds"]);
  expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([[4, 7], [3], [1], [2, 5, 6]]);
  expect(groupFunds([{ category: "theme" }]).map((group) => group.id)).toEqual(["theme"]);
  expect(groupOf("Theme")).toBe("other");
});

test("a new fund's row shows — for return and drawdown", async () => {
  const { MemoryRouter } = await import("react-router-dom");
  const { BoardRow } = await import("../src/features/vaults/FundBoard");
  const { synthesizeCommunityFund } = await import("../src/lib/community-fund");
  const fund = synthesizeCommunityFund({
    id: 30, name: "AI Chips", provider: "0x1", onchainId: 30, description: "", createdAt: "2026-11-20T00:00:00Z",
    positions: [{ p: "NVDAB", loc: "NVDAB", w: 60 }, { p: "USDT", loc: "USDT", w: 40 }], catalogKey: "ai-chips",
  });
  const html = renderToStaticMarkup(
    <MemoryRouter><BoardRow fund={fund} period="1Y" url="/strategies/30" rank={null} meta="Theme" /></MemoryRouter>,
  );
  expect(html).toContain('<span class="mkt-row-return"><strong class="">—</strong></span>');
  expect(html).toContain('<span class="mkt-row-dd">—</span>');
  expect(html).not.toContain("mkt-trend");
});

test("funds without art get a plain plate on the fund page, never a made-up picture", () => {
  const overview = fs.readFileSync("src/features/reference/FundOverview.tsx", "utf8");
  expect(overview).toContain('art || meta === undefined ? " is-plate"');
  expect(overview).toContain("// 還沒有封面的基金：只有色板（中性，使用者 2026-11-20），封面等之後補。\n                null");
});
