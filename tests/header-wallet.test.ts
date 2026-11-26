import { expect, test } from "bun:test";
import fs from "node:fs";

// 使用者 2026-11-15：「右上角好像就不需要那個錢包 icon 了，因為已經有 profile 了」。
// Privy 模式下標頭那一顆平常不顯示；登入在要買／建立時出現，帳號功能在 Profile 的齒輪面板。

test("the header wallet button never shows in Privy mode, not even while signing in or after a failure", () => {
  const menu = fs.readFileSync("src/components/PrivyWalletMenu.tsx", "utf8");
  expect(menu).toContain('if (!inline) return <div className="wallet-menu" ref={rootRef} hidden />;');
  expect(menu).not.toContain("headerHidden");
  // 藏起來的時候元件還掛著（頁面上的 Sign in 連結與 /#wallet 靠它的事件監聽）。
  const hidden = menu.indexOf("if (!inline) return");
  expect(menu.indexOf("window.addEventListener(openEvent, onOpen);")).toBeLessThan(hidden);
});

test("everything the header menu offered is still reachable from Profile", () => {
  const profile = fs.readFileSync("src/features/portfolios/ProfileCard.tsx", "utf8");
  expect(profile).toContain("SignOutButton");
  expect(profile).toMatch(/exportWallet/);
  expect(profile).toMatch(/LinkedAccounts/);
  // 導覽列有 Profile。
  expect(fs.readFileSync("src/components/TopBar.tsx", "utf8")).toContain("label: 'Profile'");
});
