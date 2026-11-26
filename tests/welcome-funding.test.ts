import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { ApiError } from "../src/lib/api";
import {
  DAILY_REQUIRED,
  DAILY_TEST_USDT,
  WELCOME_PENDING,
  WELCOME_TEST_USDT,
  faucetFailure,
  forgetClaim,
  needsDailyFaucet,
  pendingClaim,
  rememberClaim,
  retryClaimLater,
} from "../src/lib/faucet";

// backend#94：測試網第一次買入有迎新 10,000（每人一次），之後每天領 1,000；積分、任務、邀請關閉。

const store = new Map<string, string>();
const original = (globalThis as { localStorage?: unknown }).localStorage;
beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});
afterAll(() => { (globalThis as { localStorage?: unknown }).localStorage = original; });

test("the amounts follow the testnet parameters and say they are test tokens", () => {
  expect(WELCOME_TEST_USDT).toBe("10,000");
  expect(DAILY_TEST_USDT).toBe("1,000");
  expect(DAILY_REQUIRED.message).toContain("one per person");
  expect(DAILY_REQUIRED.message).toContain("1,000 test USDT");
  expect(WELCOME_PENDING.message).toContain("press the button again");
});

test("DAILY_FAUCET_REQUIRED sends the user to the daily claim; nothing else does", () => {
  expect(needsDailyFaucet(new ApiError(409, "DAILY_FAUCET_REQUIRED", "x"))).toBe(true);
  expect(needsDailyFaucet(new ApiError(409, "FUNDING_EVENT_CONFLICT", "x"))).toBe(false);
  expect(needsDailyFaucet(new Error("DAILY_FAUCET_REQUIRED"))).toBe(false);
  // 已經領過今天的（429）：明天再來。
  expect(faucetFailure(new ApiError(429, "FAUCET_QUOTA_EXCEEDED", "x")).message).toContain("Come back tomorrow");
});

test("a daily claim that was not recorded yet is kept per fund until it is", () => {
  expect(pendingClaim(7)).toBeNull();
  rememberClaim(7, "123");
  expect(pendingClaim(7)).toBe("123");
  expect(pendingClaim(8)).toBeNull();
  forgetClaim(7);
  expect(pendingClaim(7)).toBeNull();
  // 後端忙或暫時讀不到：留著下次補記；其他錯誤（不屬於這個帳戶、來源衝突）：丟掉。
  expect(retryClaimLater(new ApiError(503, "EXECUTION_STORAGE_UNAVAILABLE", "x"))).toBe(true);
  expect(retryClaimLater(new ApiError(0, "NETWORK", "x"))).toBe(true);
  expect(retryClaimLater(new ApiError(409, "PORTFOLIO_BUSY", "x"))).toBe(true);
  expect(retryClaimLater(new ApiError(403, "FORBIDDEN", "x"))).toBe(false);
  expect(retryClaimLater(new ApiError(409, "FUNDING_EVENT_CONFLICT", "x"))).toBe(false);
});

// 原始碼守住流程：第一次買入先打 buy-funding；每日領取後記成投入；迎新用掉時改成每日領取，不自動多領。
test("the testnet purchase asks buy-funding first and records the daily claim as an investment", () => {
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  const api = fs.readFileSync("src/lib/api.ts", "utf8");
  expect(api).toContain("`/portfolios/${portfolioId}/buy-funding`, { method: 'POST', token, body: {} }");
  expect(api).toContain("`/portfolios/${portfolioId}/funding-lots`, { method: 'POST', token, body: { source } }");
  expect(page).toContain("retryWhileBusy(() => postBuyFunding(token, target), busyRetry)");
  expect(page).toContain("postFundingLot(token, target, { kind: 'faucet_claim', claimId: claimId as string })");
  expect(page).toMatch(/if \(!needsDailyFaucet\(cause\)\) throw cause;\s*\/\/[^\n]*\n\s*forgetPendingWelcome\(target\);\s*rememberWelcomeUsed\(target\);/);
  expect(page).toContain("setDailyNeeded(true);");
  expect(page).toContain("funding?.state === 'pending'");
  expect(page).toContain('<span className="badge">Testnet</span>');
});

test("points, quests and invites stay off in the app (POINTS_ENABLED=0)", () => {
  const files = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync(".")].filter((file) => !file.startsWith("src/reference/"));
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/['"`]\/(points|quests|invites|referrals)\b/);
  }
});
