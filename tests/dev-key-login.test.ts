import { expect, test } from "bun:test";
import fs from "node:fs";

// cre8-app#19 的兩條底線，用原始碼檢查守住（真正的驗證是 build 後搜產物，見 PR）：
// 1. dev 私鑰入口只能在 dev build 載入；2. 私鑰不進任何瀏覽器儲存。

const menu = fs.readFileSync("src/components/WalletMenu.tsx", "utf8");
const devLogin = fs.readFileSync("src/components/DevKeyLogin.tsx", "utf8");

test("the wallet menu only loads the dev key login behind import.meta.env.DEV", () => {
  expect(menu).toContain("import.meta.env.DEV ? lazy(() => import('./DevKeyLogin')) : null");
  // 不可以有靜態 import：那會把檔案（含測試金鑰）打進正式產物。
  expect(menu).not.toMatch(/^import .*DevKeyLogin/m);
  expect(menu).not.toMatch(/0x[0-9a-f]{64}/i);
});

test("no other source file imports the dev key login", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|tsx)$/.test(entry.name) && !file.endsWith("components/WalletMenu.tsx") && !file.endsWith("components/DevKeyLogin.tsx")) {
        if (fs.readFileSync(file, "utf8").includes("DevKeyLogin")) offenders.push(file);
      }
    }
  };
  walk("src");
  expect(offenders).toEqual([]);
});

test("the dev key never touches browser storage", () => {
  expect(devLogin).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
});
