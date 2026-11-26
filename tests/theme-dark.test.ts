import { expect, test } from "bun:test";
import fs from "node:fs";

// 主題「BNB family」（2026-11-20，取代 2026-11-17 的 D1 深林綠＋暖金）：預設深色（theme-dark.css），
// <html data-theme="light"> 是淺色（theme-bnb.css）。只換色：不動 vendor 與 src/reference。

const css = fs.readFileSync("src/styles/theme-dark.css", "utf8");
const bnb = fs.readFileSync("src/styles/theme-bnb.css", "utf8");
const DARK = ':where(html:not([data-theme="light"]))';

test("the dark theme, the BNB layer and the landing-page layout load after every other stylesheet", () => {
  const main = fs.readFileSync("src/main.tsx", "utf8");
  const imports = [...main.matchAll(/import ['"]\.\/styles\/([\w-]+)\.css['"]/g)].map((m) => m[1]);
  expect(imports.slice(-3)).toEqual(["theme-dark", "theme-bnb", "landing-style"]);
});

test("dark rules switch off under data-theme=light; light is the default and index.html restores a saved dark choice before paint", () => {
  expect(css).toContain(':root:not([data-theme="light"]),');
  // 每一條非色票的規則都限定在深色。
  for (const line of css.split("\n").filter((l) => /^[^\s/*@:}].*\{/.test(l))) {
    expect(line.startsWith(DARK) || line.startsWith('html:not([data-theme="light"])')).toBe(true);
  }
  const html = fs.readFileSync("index.html", "utf8");
  // 預設淺色（使用者 2026-11-20，跟新版首頁一樣）：<html> 一開始就是 light，選過深色的人才拿掉。
  expect(html).toContain('<html lang="zh-Hant" data-theme="light">');
  expect(html).toContain("localStorage.getItem('cre8.theme') === 'dark'");
  expect(html).toContain("removeAttribute('data-theme')");
  expect(html.indexOf("cre8.theme")).toBeLessThan(html.indexOf("/src/main.tsx"));
});

test("BNB palette: slate surfaces, yellow primary with dark text, Binance green/red", () => {
  for (const [token, value] of [
    ["--bnb-page", "#0b0e11"], ["--bnb-surface", "#13171c"], ["--bnb-surface-2", "#1c2128"], ["--bnb-line", "#232930"],
    ["--bnb-text", "#eaecef"], ["--bnb-text-2", "#929aa5"], ["--bnb-yellow", "#fcd535"], ["--bnb-on-yellow", "#181a1e"],
    ["--bnb-secondary", "#262d36"], ["--bnb-up", "#2ebd85"], ["--bnb-down", "#f6465d"],
  ]) expect(css).toContain(`${token}: ${value};`);
  // 字與面板對調：--ink 是淺色字、--white 是深色面板。
  expect(css).toContain("--ink: var(--bnb-text);");
  expect(css).toContain("--white: var(--bnb-surface);");
  // 主要按鈕（兩個主題共用）是黃底深字。
  expect(bnb).toMatch(/html body #root \.btn:not\(\.ghost, \.light, \.btn--ghost, :disabled\),[\s\S]*?\{\s*border-color: var\(--bnb-yellow\);\s*background: var\(--bnb-yellow\);\s*color: var\(--bnb-on-yellow\);/);
});

test("light variant: white page, dark text, no yellow as a text colour", () => {
  expect(bnb).toContain(':root[data-theme="light"],');
  for (const [token, value] of [["--bnb-page", "#ffffff"], ["--bnb-text", "#13171c"], ["--bnb-text-2", "#646d7b"], ["--bnb-line", "#eaecef"]]) {
    expect(bnb).toContain(`${token}: ${value};`);
  }
  // 設計稿的 --gold 是強調字色：不能變成黃色。
  expect(bnb).toContain("--gold: var(--bnb-text-2);");
  expect(css).toContain("--gold: var(--bnb-text-2);");
});

test("pages that reset the palette on body are covered with the same selectors", () => {
  // formal-ui.css 與 mobile-app.css 在 body 上自己設了 --ink 等色票，:root 蓋不到。
  expect(fs.readFileSync("src/styles/mobile-app.css", "utf8")).toContain("body:is(.atp-formal-market, .atp-formal-fund, .portfolio-page, .create-page, .atp-asset-page),");
  expect(css).toContain(':root:not([data-theme="light"]) body:is(.atp-formal-market, .atp-formal-fund, .portfolio-page, .create-page, .atp-asset-page),');
  expect(css).toContain(':root:not([data-theme="light"]) .app-bottom-sheet {');
  expect(bnb).toContain(':root[data-theme="light"] .app-bottom-sheet {');
});

test("stipple covers stay black ink on a light plate, the logo digits stay light", () => {
  expect(css).toContain("--print-paper: #eaecef;");
  expect(css).toContain("#atp-fund-cover.is-hedcut { background: var(--print-paper);");
  expect(css).toContain(".c8-reel { color: #eef3f7; }");
  expect(css).toContain(".signin-screen.waitlist { background: var(--bnb-page); }");
});

test("photo covers keep light text and dark glass buttons (names were dark-on-dark, buttons white-on-white)", () => {
  expect(css).toContain("#atp-fund-cover:not(.is-hedcut) h1 :is(a, button, span) { color: #f5f5f5; }");
  expect(css).toContain("#atp-fund-cover .app-fund-toolbar > :is(a, button) { background: rgba(24, 26, 32, .66); color: #f5f5f5;");
  expect(css).toMatch(/@container fund-heading \(min-width: 560px\) \{\s*:where\(html:not\(\[data-theme="light"\]\)\) body\.atp-formal-fund #root \.vault-heading:has\(#atp-fund-cover:not\(\.is-hedcut\)\) \.atp-fund-byline :is\(\.btn, \.fund-introduction-trigger\) \{ background: rgba\(24, 26, 32, \.74\); color: #f5f5f5;/);
});

test("the Buy panel is a dark panel, not the hard-coded white from public-detail-source.css", () => {
  expect(fs.readFileSync("src/styles/public-detail-source.css", "utf8")).toMatch(/body\.fund-detail-redesign #ticket\{[^}]*background:white/);
  expect(css).toContain("body.fund-detail-redesign #ticket { background: var(--white); border-color: var(--bnb-line); }");
  expect(css).toContain(".app-bottom-sheet #ticket .seg button.on { background: var(--bnb-secondary); color: var(--ink); }");
});
