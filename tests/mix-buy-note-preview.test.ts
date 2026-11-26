import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { freshNote } from "../src/features/mix/mix-copy";
import { PREVIEW_DEBOUNCE_MS } from "../src/features/mix/mix-api";

// 總管 2026-11-21 tst 實測：建立後頂部寫 Bought 但還沒成交；調比例連按打到 429，Past year 變「—」。

const ENROLLED = { kind: "mix_enrolled" as const, message: "私人組合已建立，將依設定處理買入。" };
const BOUGHT = { kind: "mix_rebalanced" as const, message: "已依組合設定完成一批買入或再平衡。" };
const CHANGED = { kind: "mix_allocation_changed" as const, message: "新比例已生效；收盤中的股票會於開盤交易。" };

test("the note after creating a mix says Bought only once a trade is recorded, like Recent", () => {
  expect(freshNote([ENROLLED], false, false)).toBe("Buying soon.");
  expect(freshNote([ENROLLED], false, true)).toBe("Buying soon. Stocks buy when the US market opens.");
  expect(freshNote([], false, true)).toBe("Buying soon. Stocks buy when the US market opens.");
  expect(freshNote([BOUGHT, ENROLLED], false, false)).toBe("Bought.");
  expect(freshNote([BOUGHT, ENROLLED], false, true)).toBe("Bought. Stocks buy when the US market opens.");
  // 舊的成交不算這次建立的
  expect(freshNote([ENROLLED, BOUGHT], false, false)).toBe("Buying soon.");
});

test("a changed mix still says Saved", () => {
  expect(freshNote([CHANGED, BOUGHT, ENROLLED], false, true)).toBe("Saved.");
  expect(freshNote([BOUGHT, ENROLLED], true, false)).toBe("Saved.");
  const page = fs.readFileSync("src/features/mix/MixPage.tsx", "utf8");
  expect(page).toContain("freshNote(mix.events, mix.pendingChange, closed !== null)");
  expect(page).not.toContain("'Bought.'");
});

test("preview waits until you stop tapping and keeps the last numbers when a request fails", () => {
  expect(PREVIEW_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
  expect(PREVIEW_DEBOUNCE_MS).toBeLessThanOrEqual(500);
  const api = fs.readFileSync("src/features/mix/mix-api.ts", "utf8");
  expect(api).toContain("const settled = useSettled(assets, previewKey(assets), PREVIEW_DEBOUNCE_MS);");
  expect(api).toContain("queryKey: ['mix-preview', settled.key]");
  expect(api).toContain("return { data: query.data ?? last.current,");
});
