import { expect, test } from "bun:test";
import fs from "node:fs";
import { ApiError } from "../src/lib/api";
import { BUSY_RETRY_INTERVAL_MS, BUSY_RETRY_TIMEOUT_MS, isPortfolioBusy, retryWhileBusy } from "../src/lib/portfolio-busy";

// cre8-app#116：第一次買入剛加入基金後撞到 409 PORTFOLIO_BUSY，自動重送同一個請求。

const busy = () => new ApiError(409, "PORTFOLIO_BUSY", "portfolio is being processed; retry the same request");

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

test("busy is retried every 3s with the same request, and the user is told once", async () => {
  const c = clock(); let calls = 0; let told = 0;
  const result = await retryWhileBusy(async () => { calls++; if (calls < 4) throw busy(); return "ok"; }, { ...c, onBusy: () => told++ });
  expect(result).toBe("ok");
  expect(calls).toBe(4);
  expect(told).toBe(1);
  expect(c.now()).toBe(3 * BUSY_RETRY_INTERVAL_MS);
});

test("gives up after 60s and throws the busy error; other errors are thrown at once", async () => {
  const c = clock(); let calls = 0;
  await expect(retryWhileBusy(async () => { calls++; throw busy(); }, c)).rejects.toMatchObject({ code: "PORTFOLIO_BUSY" });
  expect(c.now()).toBeLessThanOrEqual(BUSY_RETRY_TIMEOUT_MS);
  // 第 0 秒一次，之後每 3 秒一次，到第 60 秒為止：21 次。
  expect(calls).toBe(BUSY_RETRY_TIMEOUT_MS / BUSY_RETRY_INTERVAL_MS + 1);
  const c2 = clock(); let other = 0;
  await expect(retryWhileBusy(async () => { other++; throw new ApiError(409, "FUNDING_EVENT_CONFLICT", "x"); }, c2)).rejects.toMatchObject({ code: "FUNDING_EVENT_CONFLICT" });
  expect(other).toBe(1);
  expect(isPortfolioBusy(new ApiError(409, "OTHER", "x"))).toBe(false);
  expect(isPortfolioBusy(new Error("PORTFOLIO_BUSY"))).toBe(false);
});

test("every locked call in the buy flow goes through the retry", () => {
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("title: 'Setting up your account…'");
  expect(page).toContain("retryWhileBusy(() => postBuyFunding(token, target), busyRetry)");
  expect(page).toContain("retryWhileBusy(() => getPortfolioExecution(token, target), busyRetry)");
  // funding-lots 三處（補記上次、每日領取、錢包轉入）都包起來，沒有裸呼叫。
  expect(page.match(/retryWhileBusy\(\(\) => postFundingLot\(/g)?.length).toBe(3);
  expect(page.match(/await postFundingLot\(/g)).toBeNull();
  expect(page).not.toMatch(/funding = await postBuyFunding\(/);
});
