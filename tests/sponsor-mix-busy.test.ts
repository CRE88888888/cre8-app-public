import { expect, test } from "bun:test";
import fs from "node:fs";
import { ApiError } from "../src/lib/api";
import { MIX_BUSY_RETRY_DELAYS_MS, SponsorshipError, explainSponsorFailure, retryMixBusy } from "../src/lib/paymaster";

// 2026-11-23 portfolio 10：剛建好的 My mix 開定投，/paymaster/sponsor 回 409 MIX_BUSY（排程器／組合刷新還拿著鎖），
// 畫面直接失敗。現在短暫等一下重問；什麼都還沒簽、沒送。

const busy = () => new ApiError(409, "MIX_BUSY", "組合正在處理交易，確認完成後才能再次變更。");

test("MIX_BUSY from /paymaster/sponsor is retried with a short backoff, then succeeds", async () => {
  const waited: number[] = []; let calls = 0;
  const result = await retryMixBusy(async () => { calls++; if (calls < 3) throw busy(); return "signed"; }, { sleep: async (ms) => { waited.push(ms); } });
  expect(result).toBe("signed");
  expect(calls).toBe(3);
  expect(waited).toEqual([...MIX_BUSY_RETRY_DELAYS_MS.slice(0, 2)]);
});

test("gives up after the last delay with the busy error; other errors are not retried", async () => {
  let calls = 0;
  await expect(retryMixBusy(async () => { calls++; throw busy(); }, { sleep: async () => {} })).rejects.toMatchObject({ code: "MIX_BUSY" });
  expect(calls).toBe(MIX_BUSY_RETRY_DELAYS_MS.length + 1);
  expect(MIX_BUSY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15_000);
  let other = 0;
  await expect(retryMixBusy(async () => { other++; throw new ApiError(403, "PAYMASTER_CALL_FORBIDDEN", "x"); }, { sleep: async () => {} })).rejects.toMatchObject({ code: "PAYMASTER_CALL_FORBIDDEN" });
  expect(other).toBe(1);
  let conflict = 0;
  await expect(retryMixBusy(async () => { conflict++; throw new ApiError(409, "GAS_BUDGET_CONFLICT", "x"); }, { sleep: async () => {} })).rejects.toBeInstanceOf(ApiError);
  expect(conflict).toBe(1);
});

test("MIX_BUSY gets its own plain English sentence, with no Chinese", () => {
  const text = explainSponsorFailure("MIX_BUSY", 409);
  expect(text).toMatch(/finishing another transaction/);
  expect(text).not.toMatch(/[㐀-鿿]/);
  expect(SponsorshipError.from(busy()).code).toBe("MIX_BUSY");
  expect(SponsorshipError.from(busy()).message).not.toMatch(/[㐀-鿿]/);
});

test("the Kernel sponsor hook wraps postSponsor in the MIX_BUSY retry", () => {
  const src = fs.readFileSync(new URL("../src/lib/kernel.ts", import.meta.url), "utf8");
  expect(src).toMatch(/retryMixBusy\(\(\) => postSponsor\(args\.token, packed\)\)/);
});
