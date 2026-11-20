import { expect, test } from "bun:test";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { fundArt } from "../src/lib/fund-art";
import { synthesizeCommunityFund } from "../src/lib/community-fund";
import { FundTile } from "../src/features/vaults/FundTile";

// 使用者 2026-11-20：「找 landing 那個風格把舊的 app 改了」，預設淺色。

test("every one of the 21 launch funds has art by catalogKey; anything else gets none", () => {
  for (const key of ["mag7", "everyday", "ai-chips", "ai-memory", "ai-models", "new-giants", "korea-semiconductors", "china", "crypto-treasuries", "bitcoin-plus", "bnb", "crypto-infrastructure", "meme", "gold-bitcoin", "us-market", "soxl", "tqqq"]) {
    expect(fundArt(key)).toEqual({ kind: "ink", src: `/fund-art/${key}.webp` });
    expect(fs.existsSync(`public/fund-art/${key}.webp`)).toBe(true);
  }
  // 人物也是黃色色板上的版畫（使用者 2026-11-20），多一張深色版用的反相遮罩。
  for (const key of ["pelosi", "trump", "musk", "duan"]) {
    expect(fundArt(key)).toEqual({ kind: "ink", src: `/fund-art/${key}.webp`, srcDark: `/fund-art/${key}-dark.webp` });
    expect(fs.existsSync(`public/fund-art/${key}.webp`)).toBe(true);
    expect(fs.existsSync(`public/fund-art/${key}-dark.webp`)).toBe(true);
  }
  for (const key of ["not-a-launch-fund", "", null, undefined]) expect(fundArt(key)).toBeNull();
});

const fund = (name: string) => synthesizeCommunityFund({
  id: 30, name, provider: "0x1", onchainId: 30, description: "", createdAt: "2026-11-20T00:00:00Z",
  positions: [{ p: "NVDAB", loc: "NVDAB", w: 60 }, { p: "TSMB", loc: "TSMB", w: 40 }], catalogKey: "not-a-launch-fund",
});
const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

test("a fund tile is a plate with the engraving, the name in serif and the return as —", () => {
  const html = render(<FundTile fund={fund("AI 晶片")} art={fundArt("ai-chips")} url="/strategies/30" apy={null} />);
  expect(html).toContain('class="lp-tile lp-tile--ink"');
  expect(html).toContain('style="--src:url(/fund-art/ai-chips.webp)"');
  expect(html).toContain('<h3 class="lp-tile-name">AI 晶片</h3>');
  expect(html).toContain('<b class="">—</b>');
  const priced = render(<FundTile fund={fund("AI chips")} art={fundArt("ai-chips")} url="/x" apy={{ apy: 12.345, asOf: "2026-11-19" }} />);
  expect(priced).toContain('<b class="pos">+12.35%<small> APY</small></b>');
  expect(priced).toContain('title="Estimated APY from model history to 2026-11-19. NVDA · TSM"');
  expect(html).toContain('href="/strategies/30"');
});

test("people tiles are engravings on the plate with a dark-theme mask; funds without art are a plain plate", () => {
  const person = render(<FundTile fund={fund("Pelosi")} art={fundArt("pelosi")} url="/x" apy={null} />);
  expect(person).toContain('class="lp-tile lp-tile--person"');
  expect(person).toContain('style="--src:url(/fund-art/pelosi.webp);--src-dark:url(/fund-art/pelosi-dark.webp)"');
  expect(person).not.toContain("<img");
  const plain = render(<FundTile fund={fund("Unknown fund")} art={null} url="/x" apy={null} />);
  expect(plain).toContain('class="lp-tile lp-tile--plain"');
  expect(plain).not.toContain("lp-ink");
  // 卡片上沒有小字（使用者 2026-11-20）：High risk 與成分只給螢幕閱讀器，成分另外放在滑過提示。
  const leveraged = render(<FundTile fund={fund("三倍納指")} art={fundArt("tqqq")} url="/x" apy={null} note="High risk" />);
  expect(leveraged).toContain('<span class="sr-only">Estimated APY not available yet, High risk. Holdings: NVDA · TSM</span>');
  expect(leveraged).toContain('title="NVDA · TSM"');
  expect(leveraged).not.toContain("<i>");
});

test("launch funds show English names; the backend's Chinese names never reach the screen", async () => {
  const { launchName } = await import("../src/lib/fund-art");
  const keys = ["mag7", "everyday", "ai-chips", "ai-memory", "ai-models", "new-giants", "korea-semiconductors", "china", "crypto-treasuries", "bitcoin-plus", "bnb", "crypto-infrastructure", "meme", "gold-bitcoin", "us-market", "pelosi", "trump", "duan", "musk", "soxl", "tqqq"];
  for (const key of keys) expect(launchName(key)).toMatch(/^[\x20-\x7e]+$/);
  expect(launchName("not-a-launch-fund")).toBeUndefined();
  const named = synthesizeCommunityFund({
    id: 25, name: "川普持倉", provider: "0x1", onchainId: 25, description: "", createdAt: "2026-11-20T00:00:00Z",
    positions: [{ p: "ETH", loc: "ETH", w: 100 }], catalogKey: "trump",
  });
  expect(named.name).toBe("Donald Trump");
});

test("the list and the fund page use the landing layout", () => {
  const vaults = fs.readFileSync("src/features/vaults/VaultsPage.tsx", "utf8");
  expect(vaults).toContain("<h1>Own the idea you believe in.</h1>");
  expect(vaults).toContain('<section className="lp-sec"');
  // 區塊標題右邊不放說明句（使用者 2026-11-20）。
  expect(vaults).not.toContain("group.lead");
  expect(vaults).toContain("art={fundArt(row.strategy.catalogKey)}");
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("art={fundArt(strategyId !== null ? communityStrategy.data?.catalogKey : slug)}");
  const css = fs.readFileSync("src/styles/landing-style.css", "utf8");
  // 淺色：黃色色板配黑線；深色：深灰色板配黃線（跟首頁一樣）。
  expect(css).toMatch(/:root\[data-theme="light"\] \{\n  --lp-plate: #fcd535;\n  --lp-on-plate: #14151a;\n  --lp-art: #14151a;/);
  expect(css).toMatch(/:root:not\(\[data-theme="light"\]\) \{\n  --lp-plate: #1e2329;\n  --lp-on-plate: #eaecef;\n  --lp-art: #fcd535;/);
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
});

test("cards show the backend's estimated APY from the list; the fund page uses the backend model history", async () => {
  const { annualizedOf, parsePct, navFromApi, withModelHistory } = await import("../src/lib/model-history");
  const returns = { asOf: "2026-11-19", d7: "-2.50000000", d30: null, d90: "4.00000000", y1: null, all: "3.64306676", annualized: "12.25000000" };
  expect(annualizedOf(returns)).toEqual({ apy: 12.25, asOf: "2026-11-19" });
  expect(annualizedOf({ ...returns, annualized: null })).toBeNull();
  expect(annualizedOf(null)).toBeNull();
  expect(parsePct("-27.26742900")).toBeCloseTo(-27.267429, 8);
  for (const value of [null, undefined, "", "abc"]) expect(parsePct(value)).toBeNull();
  // modelNav 的 value 是字串，由舊到新；壞點略過。
  expect(navFromApi([{ date: "2026-11-19", value: "1.1" }, { date: "bad", value: "1" }, { date: "2026-11-18", value: "1.000000000000" }]))
    .toEqual([{ t: Date.parse("2026-11-18"), v: 1 }, { t: Date.parse("2026-11-19"), v: 1.1 }]);
  expect(navFromApi([])).toEqual([]);
  // 目錄基金也換成後端的資料（不再用內建回測）；沒有資料就是空的。
  const day = 86_400_000;
  const nav = [1, 1.2, 0.9, 1.05].map((value, i) => ({ date: new Date(Date.UTC(2026, 10, 1) + i * day).toISOString().slice(0, 10), value: String(value) }));
  const base = synthesizeCommunityFund({ id: 27, name: "美股七巨頭 Mag7", provider: "0x1", onchainId: 1, description: "", createdAt: "2026-11-01T00:00:00Z", positions: [], catalogKey: "mag7" });
  expect(base.nav.length).toBeGreaterThan(10); // 目錄的舊回測
  const live = withModelHistory(base, { modelNav: nav, modelReturns: returns });
  expect(live.nav).toHaveLength(4);
  expect(live.returns).toEqual({ "7D": -2.5, "30D": null, "90D": 4, "1Y": null, ALL: 3.64306676 });
  expect(live.maxDrawdown.ALL).toBeCloseTo(-25, 8);
  const empty = withModelHistory(base, { modelNav: [], modelReturns: null });
  expect(empty.nav).toEqual([]);
  expect(Object.values(empty.returns).every((value) => value === null)).toBe(true);
  const vaults = fs.readFileSync("src/features/vaults/VaultsPage.tsx", "utf8");
  expect(vaults).toContain("apy: annualizedOf(strategy.modelReturns)");
  expect(vaults).not.toContain("getStrategy");
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("return withModelHistory(synthesizeCommunityFund({");
});

test("leveraged fund pages carry the high-risk line; hidden funds open but cannot be bought", async () => {
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("const delisted = strategyId !== null && communityStrategy.data?.isPublic === false;");
  expect(page).toContain("groupOf((strategyId !== null ? communityStrategy.data?.category : linkedStrategy.data?.category) ?? null) === 'leveraged'");
  // 高風險說明要講到每日重設的長期耗損。
  expect(page).toMatch(/LEVERAGED_RISK_TEXT = 'High risk\. .*reset their leverage every day\. Over time the daily reset erodes returns/);
  // 已下架：買的按鈕停用、送單前擋住，賣不受影響。
  expect(page).toContain("buyingPaused !== null || delisted ||");
  expect(page).toContain("disabled={!gatedDepositValid || delisted}");
  expect(page).toContain("if (delisted) throw new Error(`${DELISTED_TEXT} Nothing was transferred.`);");
  const overview = fs.readFileSync("src/features/reference/FundOverview.tsx", "utf8");
  expect(overview).toContain('<p key={notice.id} className="fine warn fund-notice" role="note" data-entry={notice.id}>{notice.text}</p>');
  const vaults = fs.readFileSync("src/features/vaults/VaultsPage.tsx", "utf8");
  expect(vaults).toContain("groupFunds([...rows].sort((a, b) => a.strategy.id - b.strategy.id))");
  // 列表不放槓桿說明（C3 2026-11-20）。
  expect(vaults).not.toContain("High risk");
});

test("the model return section says which components joined the backtest late or not yet; cards never do", async () => {
  const { inclusionNote } = await import("../src/lib/model-history");
  const nav = [{ date: "2024-11-20", value: "1" }, { date: "2026-11-19", value: "1.2" }];
  // Musk：SpaceX 比回測第一天晚計入。
  expect(inclusionNote([{ symbol: "TSLAB", includedFrom: "2024-11-20" }, { symbol: "SPCXB", includedFrom: "2026-07-12" }], nav))
    .toBe("SpaceX is included in the backtest from 2026-07-12.");
  // New giants：回測從 SpaceX 上市那天開始，Anthropic 還沒計入。
  expect(inclusionNote([{ symbol: "SPCXB", includedFrom: "2026-07-12" }, { symbol: "ANTB", includedFrom: null }], [{ date: "2026-07-12", value: "1" }, { date: "2026-11-19", value: "0.94" }]))
    .toBe("Anthropic is not included yet.");
  expect(inclusionNote([{ symbol: "SPCXB", includedFrom: "2026-07-12" }, { symbol: "ANTB", includedFrom: null }], nav))
    .toBe("SpaceX is included in the backtest from 2026-07-12; Anthropic is not included yet.");
  // 全部從第一天就計入、或沒有資料：沒有小字。
  expect(inclusionNote([{ symbol: "AAPLB", includedFrom: "2024-11-20" }], nav)).toBeNull();
  expect(inclusionNote(undefined, nav)).toBeNull();
  expect(inclusionNote([], [])).toBeNull();
  // 查得到的成分用 ticker。
  expect(inclusionNote([{ symbol: "NVDAB", includedFrom: "2025-01-02" }], nav)).toBe("NVDA is included in the backtest from 2025-01-02.");
  const overview = fs.readFileSync("src/features/reference/FundOverview.tsx", "utf8");
  expect(overview).toContain('{modelNote && <p className="fine" data-entry="model-inclusion">{modelNote}</p>}');
  expect(fs.readFileSync("src/features/vaults/FundTile.tsx", "utf8")).not.toContain("inclusion");
});

test("every launch fund has a short English description of its theme and core holdings; others fall back", async () => {
  const { launchDescription, LAUNCH_METHOD } = await import("../src/lib/fund-copy");
  const keys = ["mag7", "everyday", "ai-chips", "ai-memory", "ai-models", "new-giants", "korea-semiconductors", "china", "crypto-treasuries", "bitcoin-plus", "bnb", "crypto-infrastructure", "meme", "gold-bitcoin", "us-market", "pelosi", "trump", "duan", "musk", "soxl", "tqqq"];
  for (const key of keys) {
    const text = launchDescription(key);
    expect(text).toBeDefined();
    // 英文、一兩句、不寫報酬、保證或買賣建議（C3 2026-11-20）。
    expect(text!).toMatch(/^[\x20-\x7e’]+$/);
    expect(text!.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
    expect(text!).not.toMatch(/return|guarantee|profit|yield|APY|should|buy now|%/i);
  }
  // 舊的 Mag7 目錄說明還寫著每週分批買入；新說明不提買法。
  expect(launchDescription("mag7")).not.toMatch(/tranche|weekly/i);
  expect(launchDescription("not-a-launch-fund")).toBeUndefined();
  expect(launchDescription(null)).toBeUndefined();
  expect(LAUNCH_METHOD).toContain("rebalances once a month, and whenever an asset moves more than 5 points");
  const overview = fs.readFileSync("src/features/reference/FundOverview.tsx", "utf8");
  expect(overview).toContain("copy = launchCopy ? { ...base, paragraphs: [launchCopy.description], methodology: [launchCopy.description, launchCopy.method] } : base;");
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("launchCopy={launchCopyFor(strategyId !== null ? communityStrategy.data?.catalogKey : null)}");
});

test("launch funds (with a catalogKey) do not show the old model's Recent trades", () => {
  // 那是目錄舊回測的調整紀錄，不是這檔基金實際的交易（C3 2026-11-20）；之後有真實再平衡紀錄再決定。
  const overview = fs.readFileSync("src/features/reference/FundOverview.tsx", "utf8");
  expect(overview).toContain("{!hideModelTrades && <RecentTrades fund={fund} />}");
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("hideModelTrades={strategyId !== null && Boolean(communityStrategy.data?.catalogKey)}");
});
