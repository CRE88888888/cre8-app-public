import { expect, test } from "bun:test";
import fs from "node:fs";

// 使用者 2026-11-17：「token 也要有 icon」——基金列表（All funds、Community）的持股欄。

test("fund list rows show a logo in front of each listed token", () => {
  const board = fs.readFileSync("src/features/vaults/FundBoard.tsx", "utf8");
  const row = board.slice(board.indexOf('<span className="mkt-row-holdings">'));
  expect(row).toContain('<span key={row.symbol} className="mkt-row-token">');
  expect(row).toContain('{row.logo && <img src={row.logo} alt="" width="14" height="14" loading="lazy" />}');
  expect(row).not.toContain('.join(" · ")');
  const css = fs.readFileSync("src/styles/market.css", "utf8");
  expect(css).toContain("#fund-explore .mkt-row-token img { width: 14px; height: 14px;");
});
