import { expect, test } from "bun:test";
import fs from "node:fs";

// 2026-11-19：artifact 儲存額度用完，Upload dist 讓每個 PR 的 CI 都變紅；部署走 Workers Builds，沒人下載 dist，所以拿掉。
test("CI checks tests, types and build without uploading a dist artifact", () => {
  const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  expect(ci).not.toContain("actions/upload-artifact");
  for (const step of ["run: bun install --frozen-lockfile", "run: bun test tests", "run: bun run typecheck", "run: bun run build"]) expect(ci).toContain(step);
});
