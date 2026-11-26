import { expect, test } from "bun:test";
import fs from "node:fs";

// 使用者 2026-11-15：「還沒登入的時候就不要有 sell 按鈕了，他也只能 buy」。

test("signed-out visitors only see Buy: no Sell button, no Sell tab, and Sell links land on Buy", () => {
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("const canSell = token !== null;");
  // 手機底部的 Sell 只在登入後出現。
  const sell = page.indexOf("onClick={() => openMobileTicket('withdraw')}>Sell</button>");
  expect(page.lastIndexOf("{canSell && (", sell)).toBeGreaterThan(page.lastIndexOf("public-mobile-cta", sell));
  // 桌機的 Buy／Sell 分頁只在登入後出現。
  expect(page).toContain("{!mobile && canSell && (");
  // `?tab=withdraw` 或登出時停在 Sell：回到 Buy。
  expect(page).toContain("if (!canSell && tab === 'withdraw') setTab('deposit');");
});
