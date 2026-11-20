import { expect, test } from "bun:test";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { fundArt } from "../src/lib/fund-art";
import { synthesizeCommunityFund } from "../src/lib/community-fund";
import { FundTile } from "../src/features/vaults/FundTile";

// 使用者 2026-11-20：「找 landing 那個風格把舊的 app 改了」，預設淺色。

test("the 21 launch funds get the landing page's art by catalogKey; the rest get none", () => {
  for (const key of ["mag7", "everyday", "ai-chips", "ai-memory", "ai-models", "crypto-treasuries", "bitcoin-plus", "china", "korea-semiconductors", "us-market", "tqqq"]) {
    expect(fundArt(key)).toEqual({ kind: "ink", src: `/fund-art/${key}.webp` });
    expect(fs.existsSync(`public/fund-art/${key}.webp`)).toBe(true);
  }
  // 人物也是黃色色板上的版畫（使用者 2026-11-20），多一張深色版用的反相遮罩。
  for (const key of ["pelosi", "trump", "musk", "duan"]) {
    expect(fundArt(key)).toEqual({ kind: "ink", src: `/fund-art/${key}.webp`, srcDark: `/fund-art/${key}-dark.webp` });
    expect(fs.existsSync(`public/fund-art/${key}.webp`)).toBe(true);
    expect(fs.existsSync(`public/fund-art/${key}-dark.webp`)).toBe(true);
  }
  for (const key of ["new-giants", "bnb", "soxl", "", null, undefined]) expect(fundArt(key)).toBeNull();
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
  const priced = render(<FundTile fund={fund("AI chips")} art={fundArt("ai-chips")} url="/x" apy={{ apy: 12.345, days: 180 }} />);
  expect(priced).toContain('<b class="pos">+12.35%<small> APY</small></b>');
  expect(priced).toContain('title="Estimated APY from 180 days of model history. NVDA · TSM"');
  expect(html).toContain('href="/strategies/30"');
});

test("people tiles are engravings on the plate with a dark-theme mask; funds without art are a plain plate", () => {
  const person = render(<FundTile fund={fund("Pelosi")} art={fundArt("pelosi")} url="/x" apy={null} />);
  expect(person).toContain('class="lp-tile lp-tile--person"');
  expect(person).toContain('style="--src:url(/fund-art/pelosi.webp);--src-dark:url(/fund-art/pelosi-dark.webp)"');
  expect(person).not.toContain("<img");
  const plain = render(<FundTile fund={fund("BNB ecosystem")} art={null} url="/x" apy={null} />);
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

test("the card number is an estimated APY: compounded over the model history, none under 30 days", async () => {
  const { estimatedApy, navFromApi, APY_MIN_DAYS } = await import("../src/lib/estimated-apy");
  const day = 86_400_000;
  // 半年漲 10%：年化 (1.1)^(365/182.5) − 1 = 21%。
  const half = estimatedApy([{ t: 0, v: 100 }, { t: 182.5 * day, v: 110 }]);
  expect(half?.apy).toBeCloseTo(21, 6);
  expect(half?.days).toBe(182.5);
  // 一整年就是原本的報酬。
  expect(estimatedApy([{ t: 0, v: 1 }, { t: 365 * day, v: 0.9 }])?.apy).toBeCloseTo(-10, 6);
  expect(APY_MIN_DAYS).toBe(30);
  expect(estimatedApy([{ t: 0, v: 1 }, { t: 29 * day, v: 1.2 }])).toBeNull();
  expect(estimatedApy([{ t: 0, v: 1 }])).toBeNull();
  expect(estimatedApy(null)).toBeNull();
  expect(estimatedApy([{ t: 0, v: 0 }, { t: 90 * day, v: 1 }])?.apy).toBe(undefined);
  // 後端 modelNav（backend#173）：{date, value}，排序、略過壞點。
  expect(navFromApi([{ date: "2026-02-01", value: 1.1 }, { date: "bad", value: 1 }, { date: "2026-01-01", value: 1 }]))
    .toEqual([{ t: Date.parse("2026-01-01"), v: 1 }, { t: Date.parse("2026-02-01"), v: 1.1 }]);
  expect(navFromApi(null)).toEqual([]);
  const vaults = fs.readFileSync("src/features/vaults/VaultsPage.tsx", "utf8");
  expect(vaults).toContain("const apy = estimatedApy(nav.length > 1 ? nav : twin ? fund.nav : null);");
  expect(vaults).not.toContain("Model return period");
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
