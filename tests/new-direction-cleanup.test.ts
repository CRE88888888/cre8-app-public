import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// cre8-app#123（2026-11-19 產品說明 §3.2、§3.3、§9#1）：基金只由平台上架；績效費、第三批策略、借款第一階段暫停。
// 這裡守住「入口不存在」：路由、導覽、頁面檔、文案都不會再出現。

const read = (file: string) => fs.readFileSync(file, "utf8");
const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return file.startsWith(path.join("src", "reference")) ? [] : sources(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });

test("no route, page or file for creating funds, Studio, creators or the leaderboard", () => {
  const app = read("src/App.tsx");
  for (const route of ['path="/create', 'path="/studio', 'path="/leaderboard"', 'path="/creator/']) expect(app).not.toContain(route);
  // 舊網址交給最後的 * 回到 /vaults。
  expect(app).toContain('<Route path="*" element={<Navigate to="/vaults" replace />} />');
  for (const gone of [
    "src/features/create", "src/features/studio", "src/features/strategy",
    "src/features/reference/CreatorPage.tsx", "src/features/reference/Leaderboard.tsx", "src/features/reference/CreatorControls.tsx",
    "src/lib/creators.ts", "src/lib/app-mode.ts", "src/lib/activation-design.ts", "src/lib/design-export.ts",
    "src/styles/builder.css", "src/styles/creators.css",
  ]) expect(`${gone}: ${fs.existsSync(gone)}`).toBe(`${gone}: false`);
});

test("the header has only Funds and Profile: no Create a fund, no Creators, no Studio switch", () => {
  // 去掉註解再檢查（註解裡會提到拿掉了什麼）。
  const bar = read("src/components/TopBar.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(bar).toContain("label: 'Funds'");
  expect(bar).toContain("label: 'Profile'");
  expect(bar).not.toMatch(/Create a fund|Creators|Studio|ModeSwitch|app-mode-switch/);
  // 手機底部分頁只剩兩個，平均分兩欄。
  expect(read("src/styles/mobile-app.css")).toContain('#root .app-mobile-nav[data-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
});

test("nothing in the app links to the removed pages", () => {
  for (const file of sources("src")) {
    const source = read(file);
    expect(`${file}: ${/to=["'`]\/(create|studio|leaderboard|creator)\b/.test(source)}`).toBe(`${file}: false`);
  }
});

test("no performance fee, third-batch strategy or borrowing text on any page", () => {
  for (const file of sources("src").filter((name) => name.endsWith(".tsx"))) {
    const source = read(file);
    expect(`${file}: ${/Performance fee|% of profit|Borrow|Limit, take-profit|Buy the dip|Range trade|Ride the trend/.test(source)}`).toBe(`${file}: false`);
  }
});
