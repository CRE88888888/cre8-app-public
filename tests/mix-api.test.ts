import { afterEach, expect, test } from "bun:test";
import { ApiError } from "../src/lib/api";
import { mixApi, needsSignature, newIdempotencyKey } from "../src/features/mix/mix-api";
import { MixPayloadError, checkSigningPayload, freshCreationPayload, pendingMixFunding, recordMixFunding, versionMatchesPicks } from "../src/features/mix/mix-chain";
import { errorText, mixErrorText } from "../src/features/mix/mix-copy";
import { sameAssets } from "../src/features/mix/mix-math";
import { ACCOUNT, BACKEND_CODES, SELL_ONLY, CREATED, DETAIL, EXECUTOR, NVDAB, ONCHAIN_ID, REGISTRY, TSLAB, USDT, approveData, enrollData, transferData } from "./fixtures/mix-fixtures";

// My mix 接真 API（cre8-app#132，backend#179）：路徑、方法、標頭照後端文件；簽名前核對後端給的 calls；錯誤一律白話英文。

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function capture(status: number, response: unknown): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(init.body as string) });
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
  return seen;
}

const assets = [{ assetId: NVDAB as `0x${string}`, weightBps: 6000 }, { assetId: TSLAB as `0x${string}`, weightBps: 4000 }];

test("creating a mix sends the Idempotency-Key and the sign-in token", async () => {
  const seen = capture(201, CREATED);
  const key = newIdempotencyKey();
  expect(key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  const body = { name: "My tech", assets, rebalance: { frequency: "monthly" as const, startDate: "2026-11-21" }, exit: { takeProfitBps: 3000, stopLossBps: 2000 } };
  const result = await mixApi.create("tok", body, key);
  expect(seen[0]!.url).toBe("/api/me/mixes");
  expect(seen[0]!.method).toBe("POST");
  expect(seen[0]!.headers["Idempotency-Key"]).toBe(key);
  expect(seen[0]!.headers.authorization).toBe("Bearer tok");
  expect(seen[0]!.body).toEqual(body);
  expect(result.mixId).toBe(7);
});

test("preview and shared links work without signing in", async () => {
  const seen = capture(200, {});
  await mixApi.preview(assets);
  await mixApi.shared("aiBitcoinMix0000000000001");
  expect(seen.map((s) => [s.method, s.url])).toEqual([["POST", "/api/mixes/preview"], ["GET", "/api/mixes/shared/aiBitcoinMix0000000000001"]]);
  expect(seen[0]!.body).toEqual({ assets });
  for (const s of seen) expect(s.headers.authorization).toBeUndefined();
});

test("a shared link that is gone comes back as MIX_NOT_FOUND and reads as plain English", async () => {
  capture(404, { error: { code: "MIX_NOT_FOUND", message: "找不到這個私人組合或分享連結。" } });
  const error = await mixApi.shared("nope0000000000000000000000").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe("MIX_NOT_FOUND");
  expect(mixErrorText(error)).toBe("This mix is no longer available. Build your own instead.");
});

test("list, detail, change, confirm and restart hit the documented routes", async () => {
  const seen = capture(200, { mixes: [DETAIL] });
  await mixApi.list("tok");
  await mixApi.get("tok", 7);
  await mixApi.patch("tok", 7, { name: "New name" });
  await mixApi.prepare("tok", 7);
  await mixApi.confirm("tok", 7, `0x${"ab".repeat(32)}`);
  await mixApi.restart("tok", 7);
  expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
    "GET /api/me/mixes", "GET /api/me/mixes/7", "PATCH /api/me/mixes/7", "POST /api/me/mixes/7/enrollment-params",
    "POST /api/me/mixes/7/confirm", "POST /api/me/mixes/7/restart",
  ]);
  expect(seen[4]!.body).toEqual({ txHash: `0x${"ab".repeat(32)}` });
  for (const s of seen) expect(s.headers.authorization).toBe("Bearer tok");
});

test("a change that returns calls needs a signature; a rename does not", () => {
  expect(needsSignature(CREATED as never)).toBe(true);
  expect(needsSignature(DETAIL as never)).toBe(false);
});

const book = { registry: REGISTRY.toLowerCase(), executor: EXECUTOR.toLowerCase(), assets: new Set([NVDAB, TSLAB, USDT].map((a) => a.toLowerCase())) };
const withCalls = (calls: { to: string; value?: string; data: string }[], patch: Record<string, unknown> = {}) =>
  () => checkSigningPayload({ ...CREATED, ...patch, calls: calls.map((c) => ({ value: "0", ...c })) }, book);
const enrollCall = { to: REGISTRY, data: enrollData() };

test("the signing payload is used as sent when every call decodes to an allowed approve and a final enroll", () => {
  const payload = checkSigningPayload(CREATED, book);
  expect(payload.nonce).toBe("18446744073709551616");
  expect(payload.calls).toHaveLength(3);
  expect(payload.onchainId).toBe(ONCHAIN_ID);
  expect(withCalls([enrollCall])().onchainId).toBe(ONCHAIN_ID);
});

test("anything unexpected in the payload shape stops before signing", () => {
  const bad = (patch: Record<string, unknown>) => () => checkSigningPayload({ ...CREATED, ...patch }, book);
  expect(bad({ signingMode: "session" })).toThrow(MixPayloadError);
  expect(bad({ nonce: null })).toThrow(MixPayloadError);
  expect(bad({ expectedVersion: 2 })).toThrow(MixPayloadError);
  expect(bad({ calls: [] })).toThrow(MixPayloadError);
  expect(bad({ account: "0x123" })).toThrow(MixPayloadError);
  expect(withCalls([{ ...enrollCall, value: "1" }])).toThrow(MixPayloadError);
  expect(mixErrorText(new MixPayloadError("calls.to"))).toContain("nothing was signed or sent");
});

test("approve is only allowed to the executor, for the full amount, on a catalogue asset or USDT", () => {
  expect(withCalls([{ to: USDT, data: approveData(EXECUTOR) }, enrollCall])().calls).toHaveLength(2);
  const stranger = "0x000000000000000000000000000000000000dEaD";
  expect(withCalls([{ to: USDT, data: approveData(stranger) }, enrollCall])).toThrow("approve.spender");
  expect(withCalls([{ to: NVDAB, data: approveData(EXECUTOR, 5n) }, enrollCall])).toThrow("approve.amount");
  expect(withCalls([{ to: stranger, data: approveData(EXECUTOR) }, enrollCall])).toThrow("approve.to");
  // registry 不是可以 approve 的資產；approve 也不能放在最後一筆。
  expect(withCalls([{ to: REGISTRY, data: approveData(EXECUTOR) }, enrollCall])).toThrow("approve.to");
  expect(withCalls([{ to: USDT, data: approveData(EXECUTOR) }])).toThrow("enroll.to");
});

test("transfer, or any other function, is never signed, even on USDT", () => {
  expect(withCalls([{ to: USDT, data: transferData("0x000000000000000000000000000000000000dEaD", 1n) }, enrollCall])).toThrow("approve.function");
  expect(withCalls([{ to: USDT, data: "0xdeadbeef" }, enrollCall])).toThrow("approve.function");
  // 合法 approve 後面多塞資料也不簽。
  expect(withCalls([{ to: USDT, data: `${approveData(EXECUTOR)}00` }, enrollCall])).toThrow(MixPayloadError);
});

test("the last call must enroll this account, version 1, at registry", () => {
  expect(withCalls([{ to: NVDAB, data: enrollData() }])).toThrow("enroll.to");
  expect(withCalls([{ to: REGISTRY, data: enrollData("0x000000000000000000000000000000000000dEaD") }])).toThrow("enroll.account");
  expect(withCalls([{ to: REGISTRY, data: enrollData(ACCOUNT, ONCHAIN_ID, 2) }])).toThrow("enroll.version");
  expect(withCalls([{ to: REGISTRY, data: enrollData(ACCOUNT, 0n) }])).toThrow("enroll.id");
  expect(withCalls([{ to: REGISTRY, data: approveData(EXECUTOR) }])).toThrow("enroll.function");
  // enroll 只能是最後一筆。
  expect(withCalls([enrollCall, enrollCall])).toThrow("approve.to");
});

test("the strategy being enrolled holds exactly the picks, plus the USDT 0 bp line every mix has on-chain", () => {
  const picks = [{ assetId: NVDAB as `0x${string}`, weightBps: 6000 }, { assetId: TSLAB as `0x${string}`, weightBps: 4000 }];
  const match = (assets: string[], weightsBps: number[]) => versionMatchesPicks({ assets, weightsBps }, picks, USDT);
  // 建立：後端 mixChainAllocation 一定加 USDT 0 bp（合約允許 numeraire 權重 0）。
  expect(match([NVDAB, TSLAB, USDT], [6000, 4000, 0])).toBe(true);
  // 改比例：舊資產 1 bp 只賣不買，從最大的成分扣，最後一樣有 USDT 0 bp。
  expect(match([NVDAB, TSLAB, SELL_ONLY, USDT], [5999, 4000, 1, 0])).toBe(true);
  // 拒絕：USDT 不是 0、出現未知資產、比例不同、少了成分。
  expect(match([NVDAB, TSLAB, USDT], [6000, 3999, 1])).toBe(false);
  expect(match([NVDAB, TSLAB, USDT], [5000, 4000, 1000])).toBe(false);
  expect(match([NVDAB, TSLAB, SELL_ONLY, USDT], [5900, 4000, 100, 0])).toBe(false);
  expect(match([NVDAB, TSLAB, SELL_ONLY, USDT], [6000, 4000, 0, 0])).toBe(false);
  expect(match([NVDAB, TSLAB, USDT], [5000, 5000, 0])).toBe(false);
  expect(match([NVDAB, USDT], [10000, 0])).toBe(false);
});

test("an expired first signature is fetched again instead of failing; an already-confirmed mix needs none", async () => {
  expect(await freshCreationPayload("tok", CREATED as never)).toBe(CREATED as never);
  const seen = capture(200, CREATED);
  expect((await freshCreationPayload("tok", { ...CREATED, calls: [] } as never))?.calls).toHaveLength(3);
  expect(seen[0]!.url).toBe("/api/me/mixes/7/enrollment-params");
  capture(409, { error: { code: "MIX_NO_PENDING_CHANGE", message: "x" } });
  expect(await freshCreationPayload("tok", { ...CREATED, calls: [] } as never)).toBeNull();
});

test("every backend error code reads as plain English, never the Chinese backend message", () => {
  for (const code of BACKEND_CODES) {
    const text = mixErrorText(new ApiError(400, code, "中文訊息"));
    expect(text).toBe(errorText(code));
    expect(/[㐀-鿿]/.test(text)).toBe(false);
    expect(text.endsWith(".")).toBe(true);
  }
  expect(mixErrorText(new ApiError(429, "RATE_LIMITED", "x"))).toBe("Too many tries in a short time. Wait a few minutes and try again.");
  expect(mixErrorText(new ApiError(401, "UNAUTHORIZED", "x"))).toBe("Your sign-in expired. Sign in again to continue.");
});

test("cancelling in the wallet says nothing was sent", () => {
  expect(mixErrorText({ name: "UserRejectedRequestError", message: "User rejected the request." })).toBe("You cancelled in your wallet. Nothing was sent.");
  expect(mixErrorText({ name: "Error", message: "wrapped", cause: { code: 4001, message: "denied" } })).toBe("You cancelled in your wallet. Nothing was sent.");
});

test("changing only the name or options keeps the same picks, so no signature is asked", () => {
  expect(sameAssets(assets, [...assets].reverse())).toBe(true);
  expect(sameAssets(assets, [{ assetId: NVDAB as `0x${string}`, weightBps: 5000 }, { assetId: TSLAB as `0x${string}`, weightBps: 5000 }])).toBe(false);
  expect(sameAssets(assets, assets.slice(0, 1))).toBe(false);
});

test("the owner signs with the nonce the backend stored, through the existing sponsor path", () => {
  const fs = require("node:fs");
  const chain = fs.readFileSync("src/features/mix/mix-chain.ts", "utf8") as string;
  const kernel = fs.readFileSync("src/lib/kernel.ts", "utf8") as string;
  expect(chain).toContain("nonce: BigInt(payload.nonce as string),");
  expect(chain).toContain("await mixApi.confirm(args.token, payload.mixId, receipt.txHash);");
  expect(kernel).toContain("const opAccount = pinnedNonce === undefined ? sudoAccount : { ...sudoAccount, getNonce: async () => pinnedNonce };");
  expect(kernel).toContain("account: opAccount,");
});

test("a missing mix or expired sign-in is not retried; a network blip is retried once", async () => {
  const { retryMixQuery } = await import("../src/features/mix/mix-api");
  expect(retryMixQuery(0, new ApiError(404, "MIX_NOT_FOUND", "x"))).toBe(false);
  expect(retryMixQuery(0, new ApiError(401, "UNAUTHORIZED", "x"))).toBe(false);
  expect(retryMixQuery(0, new ApiError(0, "NETWORK", "x"))).toBe(true);
  expect(retryMixQuery(1, new ApiError(503, "MIX_UNAVAILABLE", "x"))).toBe(false);
});

test("call book on chain 97 accepts every address-book asset, not just the 40-asset catalog (AMD mix stayed unsigned)", async () => {
  const { mixCallBook } = await import("../src/features/mix/mix-chain");
  const { CHAIN } = await import("../src/lib/kernel");
  const { TESTNET_97 } = await import("../src/lib/testnet-97");
  const assets = mixCallBook().assets;
  if (CHAIN.id !== 97) { expect(assets.has(TESTNET_97.assets.AMDB.toLowerCase())).toBe(false); return; }
  for (const address of Object.values(TESTNET_97.assets)) expect(assets.has(address.toLowerCase())).toBe(true);
  expect(assets.has(TESTNET_97.assets.AMDB.toLowerCase())).toBe(true);
});
