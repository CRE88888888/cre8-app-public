import { expect, test } from "bun:test";
import fs from "node:fs";

// 深色主題「深林綠＋暖金」（使用者 2026-11-17 選 D1）。只換色：一支檔案、最後載入、不動 vendor 與 src/reference。

const css = fs.readFileSync("src/styles/theme-dark.css", "utf8");

test("the dark theme loads after every other stylesheet", () => {
  const main = fs.readFileSync("src/main.tsx", "utf8");
  const imports = [...main.matchAll(/import ['"]\.\/styles\/([\w-]+)\.css['"]/g)].map((m) => m[1]);
  expect(imports.at(-1)).toBe("theme-dark");
});

test("D1 palette: forest-green surfaces, warm gold for actions", () => {
  for (const [token, value] of [
    ["--forest-page", "#08140f"], ["--forest-surface", "#0e1d17"], ["--forest-raised", "#142820"],
    ["--gold", "#e6b84e"], ["--gold-ink", "#14110a"], ["--positive", "#7af0bf"], ["--negative", "#ff7a70"],
  ]) expect(css).toContain(`${token}: ${value};`);
  // 字與面板對調：--ink 是淺色字、--white 是深色面板。
  expect(css).toContain("--ink: #eef5f1;");
  expect(css).toContain("--white: var(--forest-surface);");
  // 主要按鈕是暖金。
  expect(css).toMatch(/\.btn:not\(\.ghost, \.light, \.btn--ghost, :disabled\) \{ border-color: var\(--gold\); background: var\(--gold\); color: var\(--gold-ink\); \}/);
});

test("pages that reset the palette on body are covered with the same selectors", () => {
  // formal-ui.css 與 mobile-app.css 在 body 上自己設了 --ink 等色票，:root 蓋不到。
  expect(fs.readFileSync("src/styles/mobile-app.css", "utf8")).toContain("body:is(.atp-formal-market, .atp-formal-fund, .portfolio-page, .create-page, .atp-asset-page),");
  expect(css).toContain("body:is(.atp-formal-market, .atp-formal-fund, .portfolio-page, .create-page, .atp-asset-page),");
  expect(css).toContain("body.atp-formal-market, body.atp-formal-fund,");
});

test("stipple covers stay printed on paper, the logo digits stay light, the waitlist board is dark", () => {
  expect(css).toContain("--print-paper: #f1ede2;");
  expect(css).toContain("#atp-fund-cover.is-hedcut { background: var(--print-paper);");
  expect(css).toContain(".c8-reel { color: #eef3f7; }");
  expect(css).toContain(".signin-screen.waitlist { background: var(--forest-page); }");
  expect(css).toContain(".flap { background: linear-gradient(180deg, #1d3a2e 0 50%, #16301f 50% 100%);");
});

test("photo covers keep light text and dark glass buttons (names were dark-on-dark, buttons white-on-white)", () => {
  // 封面是深色照片：名稱與手機返回／分享圖示用固定淺色，不跟 --white（深色主題裡是面板色）走。
  expect(css).toContain("#atp-fund-cover:not(.is-hedcut) h1 :is(a, button, span) { color: #f4f1e8; }");
  expect(css).toContain("#atp-fund-cover .app-fund-toolbar > :is(a, button) { background: rgba(8, 20, 15, .62); color: #f4f1e8;");
  // 桌機寬版：疊在封面上的兩顆按鈕是深色玻璃＋淺字，不是 fund-page.css 的白色玻璃（字也是淺色，會白底白字）。
  expect(css).toMatch(/@container fund-heading \(min-width: 560px\) \{\s*body\.atp-formal-fund #root \.vault-heading:has\(#atp-fund-cover:not\(\.is-hedcut\)\) \.atp-fund-byline :is\(\.btn, \.fund-introduction-trigger\) \{ background: rgba\(8, 20, 15, \.72\); color: #f4f1e8;/);
});
