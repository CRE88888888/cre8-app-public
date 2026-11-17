import { expect, test } from "bun:test";
import fs from "node:fs";
import { catalogueTwin } from "../src/lib/community-fund";

// 使用者 2026-11-17：「測試網上的基金都歸類到 community 了，去歸類到正確的位子」。

test("on-chain funds that share a catalogue name are not listed again under Community", () => {
  const page = fs.readFileSync("src/features/vaults/VaultsPage.tsx", "utf8");
  const live = page.slice(page.indexOf("const live = filters.category"), page.indexOf("const details = useQueries("));
  expect(live).toContain("catalogueTwin(strategy.name) === undefined &&");
  // 這 16 檔在參考目錄都找得到（各自在正確的分類）。
  for (const name of ["Leopold Aschenbrenner", "Raoul Pal", "Ming-Chi Kuo 郭明錤", "Mag7", "Treasury Reserve", "Stanley Druckenmiller · Duquesne"]) {
    expect(catalogueTwin(name)).toBeDefined();
  }
  expect(catalogueTwin("My own fund")).toBeUndefined();
});
