import { expect, test } from "bun:test";
import fs from "node:fs";
import { catalogueTwin, symbolOf, synthesizeCommunityFund } from "../src/lib/community-fund";
import { TESTNET_97 } from "../src/lib/testnet-97";

// 使用者 2026-11-17：測試網可以買的基金（鏈上策略）要跟正式的一樣，不要縮寫封面、0x 持股。

test("testnet token addresses resolve to their symbols instead of 0x…", () => {
  expect(symbolOf(TESTNET_97.contracts.usdt)).toBe("USDT");
  for (const [symbol, address] of Object.entries(TESTNET_97.assets)) {
    expect(symbolOf(address)).toBe(symbol);
    expect(symbolOf(address.toLowerCase())).toBe(symbol);
  }
  // 主網的照舊，不認得的仍縮短。
  expect(symbolOf("0x55d398326f99059ff775485246999027b3197955")).toBe("USDT");
  expect(symbolOf("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x12…78");
});

test("a backend fund with a catalogKey uses the catalogue fund; others show no model returns", () => {
  const twin = catalogueTwin("mag7");
  const fund = synthesizeCommunityFund({
    id: 20, name: "Mag7", provider: "0xeea7f54deda94d1bcdf448a03c4f6c1f19fed94f", onchainId: 1,
    description: "x", createdAt: "2026-11-17T00:00:00Z", positions: [{ p: "AAPL", loc: "AAPL", w: 100 }], catalogKey: "mag7",
  });
  // 參考目錄的 slug：封面、介紹、持股更新都靠它（REFERENCE_METADATA）。
  expect(fund).toBe(twin!);
  // 同名但沒有 catalogKey：不靠名稱對應。
  const sameName = synthesizeCommunityFund({
    id: 21, name: "Mag7", provider: "0x1", onchainId: 2, description: "", createdAt: "2026-11-17T00:00:00Z",
    positions: [{ p: "USDT", loc: "USDT", w: 100 }],
  });
  expect(sameName.slug).toBe("community-21");
  // 首發新基金不顯示模擬報酬（使用者 2026-11-20）：報酬、回撤、走勢都空著，畫面是「—」。
  const other = synthesizeCommunityFund({
    id: 99, name: "Someone else", provider: "0x1", onchainId: 50, description: "", createdAt: "2026-11-17T00:00:00Z",
    positions: [{ p: "USDT", loc: "USDT", w: 100 }], catalogKey: "ai-chips",
  });
  expect(other.slug).toBe("community-99");
  expect(Object.values(other.returns).every((value) => value === null)).toBe(true);
  expect(Object.values(other.maxDrawdown).every((value) => value === null)).toBe(true);
  expect(other.nav).toEqual([]);
});

test("every row links by strategy id, Mag7 included", () => {
  const vaults = fs.readFileSync("src/features/vaults/VaultsPage.tsx", "utf8");
  expect(vaults).toContain("const fundUrl = (row: (typeof rows)[number]) => `/funds/strategy/${row.strategy.id}?returnTo=${encodeURIComponent(returnTo)}`;");
  expect(vaults).toContain("key={row.strategy.id}");
});

test("notices are short: one line each, long text folded away", async () => {
  // 使用者 2026-11-17：「很多警告文字很吵，可以濃縮或是收疊起來」。
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { FollowVersionsTerms } = await import("../src/features/fund/VersionNotice");
  const { FOLLOW_VERSIONS_PLAIN, FOLLOW_VERSIONS_SHORT, FOLLOW_VERSIONS_TERMS_TEXT } = await import("../src/lib/atp-contracts");
  const html = renderToStaticMarkup(createElement(FollowVersionsTerms, { terms: FOLLOW_VERSIONS_TERMS_TEXT }));
  // 只有摘要那一句在外面，完整白話版與簽名原文都在 <details> 裡。
  expect(html.startsWith('<div data-entry="follow-versions-terms"><details')).toBe(true);
  expect(html).toContain(`<summary>${FOLLOW_VERSIONS_SHORT}</summary>`);
  expect(html.indexOf(FOLLOW_VERSIONS_PLAIN.follow.slice(0, 30))).toBeGreaterThan(html.indexOf("<summary>"));
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("`First buy comes with ${WELCOME_TEST_USDT} free test USDT, then ${DAILY_TEST_USDT} a day.`");
  expect(page).not.toContain("It goes straight into this fund’s account and is invested for you.");
  const overview = fs.readFileSync("src/features/reference/FundOverview.tsx", "utf8");
  expect(overview).toContain("<summary>Disclaimer</summary>");
  expect(overview).not.toContain("<h2>Disclaimer</h2>");
});
