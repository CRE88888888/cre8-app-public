import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MASTHEAD_HEIGHT_VAR, publishMastheadHeight } from "../src/lib/masthead-height";
import { longestWordLength } from "../src/lib/cover-title";

// 使用者 2026-11-17：「這什麼 UI」——全站版面檢查（每頁 375–1440px 掃重疊、溢出）找到的問題。

const read = (file: string): string => fs.readFileSync(path.join(import.meta.dir, "..", file), "utf8");
const styles = fs.readdirSync(path.join(import.meta.dir, "../src/styles")).filter((file) => file.endsWith(".css"));

test("sticky side panels sit below the real masthead height, never a hard-coded 88px", () => {
  // 頁首在中等寬度折成兩列（約 125px），寫死 88px 時下單面板上緣的 Buy／Sell 被頁首蓋住、點不到。
  for (const file of styles) {
    const css = read(`src/styles/${file}`);
    expect(`${file}: ${/position:\s*sticky;\s*top:\s*88px/.test(css)}`).toBe(`${file}: false`);
    expect(`${file}: ${/\.side \{ top:\s*88px/.test(css)}`).toBe(`${file}: false`);
  }
  for (const [file, selector] of [
    ["src/styles/fund-page.css", "#root .vgrid > .side {"],
    ["src/styles/pages.css", 'body.atp-asset-page #root [class*="_side_"] {'],
    ["src/styles/pages.css", "#root .cf-side {"],
  ] as const) {
    const css = read(file);
    const rule = css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
    expect(rule).toContain("top: calc(var(--masthead-h, 64px) + 24px)");
  }
  expect(read("src/styles/formal-ui.css")).toContain("scroll-margin-top: calc(var(--masthead-h, 64px) + 24px)");
  // 頁首把自己的高度寫進 --masthead-h。
  const topBar = read("src/components/TopBar.tsx");
  expect(topBar).toContain("useMastheadHeight(masthead)");
  expect(topBar).toContain('<header ref={masthead} className="masthead app-masthead">');
  const set: Record<string, string> = {};
  publishMastheadHeight(124.6, { style: { setProperty: (name, value) => { set[name] = value; } } });
  expect(set).toEqual({ [MASTHEAD_HEIGHT_VAR]: "125px" });
  expect(MASTHEAD_HEIGHT_VAR).toBe("--masthead-h");
});

test("fund cover: narrow covers stack portrait over name, and the name never runs into the face", () => {
  const css = read("src/styles/covers.css");
  // 主欄窄（< 560px）：上下排，名稱與按鈕都不疊在圖上。
  expect(css).toContain("container: fund-heading / inline-size;");
  const narrow = css.slice(css.indexOf("@container fund-heading (max-width: 559.98px)"));
  expect(narrow).toContain("#atp-fund-cover.is-hedcut { display: flex; flex-direction: column; height: auto; }");
  expect(narrow).toContain("position: static;");
  expect(narrow).toContain(".atp-fund-byline { position: static;");
  // 夠寬：名稱最多到人像左緣再進去 30%，最長的字放不下就縮字。
  const wide = css.slice(css.indexOf("@container fund-heading (min-width: 560px)"), css.indexOf("@container fund-heading (max-width: 559.98px)"));
  expect(wide).toContain("max-width: calc(94% - 243px);");
  expect(wide).toContain("var(--title-word, 13)");
  // 手機也一樣用最長的字算字級。
  expect(css).toContain("font-size: clamp(20px, calc((55cqi - 14px) / (var(--title-word, 13) * 0.55)), 35px);");
  // 最長的字由 FundOverview 量出來寫進 --title-word。
  const overview = read("src/features/reference/FundOverview.tsx");
  expect(overview).toContain("<h1 ref={coverTitle}>");
  expect(overview).toContain('title.style.setProperty("--title-word", String(longestWordLength(title.textContent ?? "")))');
  expect(longestWordLength("Leopold Aschenbrenner")).toBe(13);
  expect(longestWordLength("Stanley Druckenmiller · Duquesne")).toBe(13);
  expect(longestWordLength("Bill Gates·Foundation Trust")).toBe(10);
  expect(longestWordLength("  ")).toBe(1);
});

test("fund key figures and the asset price stay inside their columns on narrow desktop widths", () => {
  const fund = read("src/styles/fund-page.css");
  expect(fund).toContain("#keyfig.public-kpis { container: fund-kpis / inline-size; }");
  expect(fund).toContain("@container fund-kpis (max-width: 420px)");
  expect(fund).toContain("@container fund-kpis (max-width: 300px)");
  // 持股表：主欄最窄時收起 24H 欄（跟手機一樣），不再被切掉、表頭互壓。
  expect(fund).toContain(".vault-allocation .dk-wrap { container: holdings / inline-size; }");
  const holdings = fund.slice(fund.indexOf("@container holdings (max-width: 340px)"));
  expect(holdings.slice(0, 200)).toContain(".holdings-table :is(th, td):nth-child(4) { display: none; }");
  const pages = read("src/styles/pages.css");
  expect(pages).toContain('[class*="_priceHeader_"] { flex-wrap: wrap; }');
  expect(pages).toContain('[class*="_priceHeader_"] > div { min-width: max-content; }');
});
