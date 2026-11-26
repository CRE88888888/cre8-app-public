import { afterEach, expect, test } from "bun:test";
import { encodeFunctionData } from "viem";
import { ApiError } from "../src/lib/api";
import { mixApi, needsSignature, newIdempotencyKey } from "../src/features/mix/mix-api";
import { MixPayloadError, assertStrategyV2, checkSigningPayload, mixCallBook, freshCreationPayload, pendingMixFunding, recordMixFunding, versionMatchesPicks, type MixChainRead } from "../src/features/mix/mix-chain";
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
  // enroll 後面只能接加息策略的重新同意：再一筆 enroll 不簽。
  expect(withCalls([enrollCall, enrollCall])).toThrow("consent.");
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

// ---- 加息策略開著時改比例：enroll 後接重新同意（backend consentCalls） ------------------------------------------
const SE = { executor: "0x16ab59a8bacb578c6437528ac0961e234e4b717b", registry: "0x973341a0ba6a725630f2a4f66d7dbba92fea4e00",
  venus: "0x93ab77260c8c62b26698bbb0ee8da3e175b9ad8d", lista: "0x993237ac050512f3749bfee2de759b6b86aea653", vault: "0x2e915b874a5a544736f5afd97f3fa1dd45d417a9" };
const NVDA_MARKET = "0xfa06dd03eff35e3337a8b5b93a8a7943155b4f20e4d19bb0583db20bdd9f5415";
const QQQ_MARKET = "0xd8def95e75d2489c340ac4d9769646707cf55d17d7aa7f8644c89b64b41844e7";
const QQQB = "0x00000000000000000000000000000000000000aa";
const seBook = { ...book, strategy: { executor: SE.executor, registry: SE.registry, venus: SE.venus, lista: SE.lista, vault: SE.vault, usdt: USDT.toLowerCase(),
  markets: new Map([[NVDA_MARKET, { token: NVDAB, protocol: "venus" as const }], [QQQ_MARKET, { token: QQQB, protocol: "lista" as const }]]) } };
const consentAbi = [
  { type: "function", name: "updateDelegate", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
  { type: "function", name: "setAuthorization", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
  { type: "function", name: "setBorrowPolicy", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "bool" }], outputs: [] },
] as const;
const delegate = (to: string, fn: "updateDelegate" | "setAuthorization", who = SE.executor, allow = true) => ({ to, data: encodeFunctionData({ abi: consentAbi, functionName: fn, args: [who as `0x${string}`, allow] }) });
const policy = (id: string, maxDebt = 10n ** 20n, enabled = true) => ({ to: SE.registry, data: encodeFunctionData({ abi: consentAbi, functionName: "setBorrowPolicy", args: [id as `0x${string}`, maxDebt, enabled] }) });
const seApprove = (token: string, spender = SE.executor) => ({ to: token, data: approveData(spender) });
/** backend consentCalls([NVDAB, QQQB]) 的順序：委託、每個市場的上限＋抵押品核准、USDT、策略 vault。 */
const consent = [delegate(SE.venus, "updateDelegate"), delegate(SE.lista, "setAuthorization"), policy(NVDA_MARKET), seApprove(NVDAB), policy(QQQ_MARKET), seApprove(QQQB),
  seApprove(USDT), seApprove(SE.vault)];
const withConsent = (tail: { to: string; data: string }[]) => () => checkSigningPayload({ ...CREATED, calls: [...CREATED.calls, ...tail].map((c) => ({ value: "0", ...c })) }, seBook);

test("yield strategy on: the re-consent after the enroll is signed as sent; only to AtpBorrowExecutor", () => {
  expect(withConsent(consent)().calls).toHaveLength(CREATED.calls.length + consent.length);
  expect(withConsent([delegate(SE.venus, "updateDelegate"), policy(NVDA_MARKET), seApprove(NVDAB), seApprove(USDT), seApprove(SE.vault)])().onchainId).toBe(ONCHAIN_ID);
  const swap = (i: number, call: { to: string; data: string }) => consent.map((c, n) => (n === i ? call : c));
  expect(withConsent(swap(7, seApprove(SE.vault, EXECUTOR)))).toThrow("consent.spender");
  expect(withConsent(swap(0, delegate(SE.venus, "updateDelegate", "0x000000000000000000000000000000000000dEaD")))).toThrow("consent.delegate");
  expect(withConsent(swap(2, policy(NVDA_MARKET, 0n)))).toThrow("consent.policy");
  expect(withConsent(swap(2, policy(NVDA_MARKET, 1n, false)))).toThrow("consent.policy");
  expect(withConsent(swap(2, policy("0x" + "11".repeat(32))))).toThrow("consent.policy");
  expect(withConsent(swap(3, seApprove(TSLAB)))).toThrow("consent.asset");
  expect(withConsent(swap(6, { to: USDT, data: transferData(SE.executor, 1n) }))).toThrow("consent.to");
  expect(withConsent([...consent, seApprove(USDT)])).toThrow("consent.duplicate");
  expect(withConsent(consent.filter((_, n) => n !== 6))).toThrow("consent.incomplete");
  expect(withConsent(consent.filter((_, n) => n !== 1))).toThrow("consent.incomplete");
  expect(withConsent(consent.filter((_, n) => n !== 5))).toThrow("consent.incomplete");
  // 沒有地址簿（不是 chain 97）就不簽任何同意。
  expect(() => checkSigningPayload({ ...CREATED, calls: [...CREATED.calls, ...consent].map((c) => ({ value: "0", ...c })) }, book)).toThrow("consent.chain");
  // 同意放在 enroll 之前會被 enroll 作廢：不簽。
  expect(() => checkSigningPayload({ ...CREATED, calls: [...consent, ...CREATED.calls].map((c) => ({ value: "0", ...c })) }, seBook)).toThrow(MixPayloadError);
});

// ---- 路由 v2 的重新同意（backend v2ReconsentCalls）：地址由後端在簽名資料宣告，App 自己核對形狀、參數與鏈上 ----------------
const OWNER = "0x00000000000000000000000000000000000000b1";
const V2 = { registry: "0x7eae73a76ff2359fe1ab059a77dd36840a32559e", executor: "0x494c106498e8221d3f72474f36995c191acf6bb5" };
const v2Abi = [{ type: "function", name: "setStrategyPolicy", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "address" }, { type: "bool" }], outputs: [] }] as const;
const v2Policy = (maxDebt = 10n ** 20n, recipient = OWNER, enabled = true, to = V2.registry) =>
  ({ to, data: encodeFunctionData({ abi: v2Abi, functionName: "setStrategyPolicy", args: [maxDebt, recipient as `0x${string}`, enabled] }) });
const v2Approve = (token: string, spender = V2.executor) => ({ to: token, data: approveData(spender) });
/** backend v2ReconsentCalls：一筆 setStrategyPolicy＋新比例裡可抵押資產的核准。 */
const reconsent = [v2Policy(), v2Approve(NVDAB), v2Approve(TSLAB)];
const withV2 = (tail: { to: string; data: string }[], patch: Record<string, unknown> = {}, owner: string | undefined = OWNER, b: typeof seBook | typeof book = seBook) => () =>
  checkSigningPayload({ ...CREATED, strategyV2: V2, ...patch, calls: [...CREATED.calls, ...tail].map((c) => ({ value: "0", ...c })) }, b, owner);

test("routing v2 re-consent: setStrategyPolicy for this wallet plus approvals to the declared v2 executor are signed as sent", () => {
  const checked = withV2(reconsent)();
  expect(checked.calls).toHaveLength(CREATED.calls.length + reconsent.length);
  expect(checked.strategyV2).toEqual(V2);
  // 只有 setStrategyPolicy（沒有新增資產）也可以；checksum 大小寫的宣告一樣認得。
  expect(withV2([v2Policy()])().strategyV2).toEqual(V2);
  expect(withV2(reconsent, { strategyV2: { registry: "0x7eae73a76Ff2359fE1aB059A77Dd36840A32559E", executor: "0x494C106498e8221D3f72474f36995C191ACf6bB5" } })().strategyV2).toEqual(V2);
  // 完整的 v2 同意（委託＋上限＋核准）也認得，委託的場所記下來給鏈上核對。
  expect(withV2([delegate(SE.venus, "updateDelegate", V2.executor), delegate(SE.lista, "setAuthorization", V2.executor), ...reconsent])().strategyV2)
    .toEqual({ ...V2, venus: SE.venus, lista: SE.lista });
});

test("routing v2 re-consent is refused for a wrong spender, a wrong owner, an extra call or a missing policy", () => {
  const swap = (i: number, call: { to: string; data: string }) => reconsent.map((c, n) => (n === i ? call : c));
  // 核准的對象不是宣告的 v2 executor（別的地址、AtpExecutor、v1 的 AtpBorrowExecutor）。
  expect(withV2(swap(1, v2Approve(NVDAB, "0x000000000000000000000000000000000000dEaD")))).toThrow("consent.spender");
  expect(withV2(swap(1, v2Approve(NVDAB, EXECUTOR)))).toThrow("consent.spender");
  expect(withV2(swap(1, v2Approve(NVDAB, SE.executor)))).toThrow("consent.spender");
  expect(withV2(swap(1, { to: NVDAB, data: approveData(V2.executor, 5n) }))).toThrow("consent.spender");
  // 獎勵收款人不是簽名的錢包；不知道錢包是誰也不簽。
  expect(withV2(swap(0, v2Policy(10n ** 20n, "0x000000000000000000000000000000000000dEaD")))).toThrow("consent.owner");
  expect(withV2(swap(0, v2Policy(10n ** 20n, ACCOUNT)))).toThrow("consent.owner");
  expect(withV2(reconsent, {}, "0x00000000000000000000000000000000000000b2")).toThrow("consent.owner");
  expect(() => checkSigningPayload({ ...CREATED, strategyV2: V2, calls: [...CREATED.calls, ...reconsent].map((c) => ({ value: "0", ...c })) }, seBook)).toThrow("consent.owner");
  // 上限 0、關閉：不是同意。
  expect(withV2(swap(0, v2Policy(0n)))).toThrow("consent.policy");
  expect(withV2(swap(0, v2Policy(10n ** 20n, OWNER, false)))).toThrow("consent.policy");
  // 多餘的呼叫：轉帳、registry 上別的函式、不在地址簿的代幣、重複、對別人的委託、v1 的呼叫混進來。
  expect(withV2([...reconsent, { to: USDT, data: transferData(V2.executor, 1n) }])).toThrow("consent.to");
  expect(withV2([...reconsent, { to: V2.registry, data: enrollData() }])).toThrow("consent.function");
  expect(withV2([...reconsent, v2Approve("0x00000000000000000000000000000000000000cc")])).toThrow("consent.to");
  expect(withV2([...reconsent, v2Approve(NVDAB)])).toThrow("consent.duplicate");
  expect(withV2([...reconsent, v2Policy()])).toThrow("consent.duplicate");
  expect(withV2([...reconsent, delegate(SE.venus, "updateDelegate", SE.executor)])).toThrow("consent.delegate");
  expect(withV2([...reconsent, delegate(SE.venus, "updateDelegate", V2.executor, false)])).toThrow("consent.delegate");
  expect(withV2([...reconsent, policy(NVDA_MARKET)])).toThrow("consent.to");
  expect(withV2([...reconsent, { to: V2.registry, data: (v2Policy().data + "00") as string }])).toThrow("consent.function");
  // 沒有給宣告的 registry 的呼叫：照 v1 核對，對 v2 executor 的核准不會過。
  expect(withV2([v2Approve(NVDAB), v2Approve(TSLAB)])).toThrow("consent.");
  expect(withV2(reconsent, { strategyV2: undefined })).toThrow("consent.");
  // 後端沒宣告地址時，給「看起來像 v2 registry」的呼叫照 v1 規則擋下。
  expect(withV2([v2Policy()], { strategyV2: undefined })).toThrow("consent.to");
});

test("the declared v2 addresses must be two new addresses, never a contract or token the app already knows", () => {
  for (const strategyV2 of [{ registry: V2.registry }, { registry: "0x12", executor: V2.executor }, "0x00", { registry: V2.registry, executor: V2.registry },
    { registry: V2.registry, executor: EXECUTOR }, { registry: REGISTRY, executor: V2.executor }, { registry: V2.registry, executor: SE.executor },
    { registry: SE.registry, executor: V2.executor }, { registry: V2.registry, executor: NVDAB }]) {
    expect(withV2(reconsent, { strategyV2 })).toThrow("strategyV2");
  }
  // 不是 chain 97（地址簿沒有加息策略）就不簽任何同意。
  expect(withV2(reconsent, {}, OWNER, book)).toThrow("consent.chain");
  // 沒有同意的 calls 時，宣告的地址不影響一般的建立／改比例。
  expect(withV2([])().strategyV2).toBeUndefined();
});

test("routing v2 addresses are checked on-chain before signing: registry.executor(), the venues, and an existing USDT allowance", async () => {
  const chain = (over: Partial<Record<"executor" | "allowance" | "venusComptroller" | "moolah", unknown>> = {}): MixChainRead => async (call) => {
    const values: Record<string, unknown> = { executor: "0x494C106498e8221D3f72474f36995C191ACf6bB5", allowance: 2n ** 256n - 1n, venusComptroller: SE.venus, moolah: SE.lista, ...over };
    if (call.functionName === "allowance") {
      expect(call.address.toLowerCase()).toBe(USDT.toLowerCase());
      expect(call.args).toEqual([ACCOUNT, V2.executor]);
    } else expect(call.address).toBe(V2.registry);
    const value = values[call.functionName];
    if (value instanceof Error) throw value;
    return value;
  };
  const full = { ...V2, venus: SE.venus, lista: SE.lista };
  await assertStrategyV2(undefined, ACCOUNT, USDT, async () => { throw new Error("must not read"); });
  await assertStrategyV2(V2, ACCOUNT, USDT, chain());
  await assertStrategyV2(full, ACCOUNT, USDT, chain());
  // registry 自己說的 executor 不是宣告的那個。
  await expect(assertStrategyV2(V2, ACCOUNT, USDT, chain({ executor: "0x000000000000000000000000000000000000dEaD" }))).rejects.toThrow("consent.v2 executor");
  // 帳戶從沒核准過這個 executor：不把資產交給新對象。
  await expect(assertStrategyV2(V2, ACCOUNT, USDT, chain({ allowance: 0n }))).rejects.toThrow("consent.v2 allowance");
  // 委託的場所不是 registry 釘住的那個。
  await expect(assertStrategyV2(full, ACCOUNT, USDT, chain({ venusComptroller: "0x000000000000000000000000000000000000dEaD" }))).rejects.toThrow("consent.v2 venue");
  await expect(assertStrategyV2(full, ACCOUNT, USDT, chain({ moolah: "0x000000000000000000000000000000000000dEaD" }))).rejects.toThrow("consent.v2 venue");
  // 讀不到就不簽。
  await expect(assertStrategyV2(V2, ACCOUNT, USDT, chain({ executor: new Error("rpc down") }))).rejects.toThrow("consent.v2 unreadable");
});

// ---- 路由 v2 的補差額合約 AtpBorrowCashSwapper：地址依 chainId 釘在 App 裡，後端宣告的 `cashSwapper` 要就是它 --------------------
const SWAPPER = "0x99811a1115b36f8310deadada818cae685360798";
const USDC = "0xb887ca3379dc41f1155dd0cb1b2e3c1d85d17ed5", USD1 = "0xea13862cb4612d228ba89b4319feec60f05ab3ac", U = "0xc71e4efb5a36bd54ad8de9e9742bfa8fbd750875";
const swBook = { ...seBook, cashSwapper: { address: SWAPPER, tokens: new Set([USDT.toLowerCase(), USDC, USD1, U]) } };
const V2S = { ...V2, cashSwapper: SWAPPER };
const swApprove = (token: string, spender = SWAPPER, amount?: bigint) => ({ to: token, data: approveData(spender, amount) });
const swapperAbi = [
  { type: "function", name: "topUp", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "cashOut", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "setPool", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }], outputs: [] },
] as const;
/** backend v2ReconsentCalls 帶上 swapperApprovals：重新同意的最後面是 USDT 與借款幣對 swapper 的核准（只補缺的）。 */
const swTail = [...reconsent, swApprove(USDT), swApprove(USDC), swApprove(USD1), swApprove(U)];
const withSwapper = (tail: { to: string; data: string }[], strategyV2: unknown = V2S, b: typeof swBook | typeof seBook = swBook) => withV2(tail, { strategyV2 }, OWNER, b as typeof seBook);

test("routing v2 re-consent may approve USDT and the loan tokens to the pinned cash swapper when the backend declares it", () => {
  const checked = withSwapper(swTail)();
  expect(checked.calls).toHaveLength(CREATED.calls.length + swTail.length);
  expect(checked.strategyV2).toEqual({ ...V2, cashSwapper: SWAPPER });
  // 只補缺的那幾筆也可以；checksum 大小寫的宣告一樣認得。
  expect(withSwapper([...reconsent, swApprove(USD1)])().strategyV2).toEqual({ ...V2, cashSwapper: SWAPPER });
  expect(withSwapper([v2Policy(), swApprove(USDT)], { ...V2, cashSwapper: "0x99811a1115B36F8310deaDAda818cAE685360798" })().strategyV2).toEqual({ ...V2, cashSwapper: SWAPPER });
  // 宣告了 swapper、但這次沒有核准給它：跟沒宣告時一樣，不多讀鏈。
  expect(withSwapper(reconsent)().strategyV2).toEqual(V2);
  // 沒宣告 `cashSwapper`（後端還沒帶這個欄位）：原本的重新同意照舊。
  expect(withSwapper(reconsent, V2)().strategyV2).toEqual(V2);
  // 宣告的 swapper 不是 App 釘住的、或這條鏈沒有釘：只要沒有核准給它，改比例不受影響。
  expect(withSwapper(reconsent, { ...V2, cashSwapper: "0x00000000000000000000000000000000000000d1" })().strategyV2).toEqual(V2);
  expect(withSwapper(reconsent, V2S, seBook)().strategyV2).toEqual(V2);
});

test("cash swapper approvals are refused unless the declared swapper is the pinned one, for USDT or a loan token, in full", () => {
  const other = "0x00000000000000000000000000000000000000d1";
  // 後端沒宣告 swapper：就算地址是對的也不簽。
  expect(withSwapper(swTail, V2)).toThrow("consent.swapper");
  // 宣告的不是 App 釘住的那個：核准給宣告的、或給釘住的，都不簽。
  expect(withSwapper([...reconsent, swApprove(USDT, other)], { ...V2, cashSwapper: other })).toThrow("consent.swapper");
  expect(withSwapper([...reconsent, swApprove(USDT)], { ...V2, cashSwapper: other })).toThrow("consent.swapper");
  // 這條鏈沒有釘 swapper（主網還沒部署）：後端宣告什麼都不簽。
  expect(withSwapper([...reconsent, swApprove(USDT)], V2S, seBook)).toThrow("consent.swapper");
  expect(withSwapper([...reconsent, swApprove(USDC)], V2S, seBook)).toThrow("consent.");
  // 只能是 USDT 與借款幣：投資組合資產不行。
  expect(withSwapper([...reconsent, swApprove(NVDAB)])).toThrow("consent.asset");
  expect(withSwapper([v2Policy(), swApprove(TSLAB)])).toThrow("consent.asset");
  // 只認全額核准；同一個代幣不重複。
  expect(withSwapper([...reconsent, swApprove(USDT, SWAPPER, 5n)])).toThrow("consent.spender");
  expect(withSwapper([...swTail, swApprove(USDC)])).toThrow("consent.duplicate");
  // 借款幣只能核准給 swapper：給 v2 executor、給別的地址都不簽。
  expect(withSwapper([...reconsent, swApprove(USDC, V2.executor)])).toThrow("consent.spender");
  expect(withSwapper([...reconsent, swApprove(USDC, other)])).toThrow("consent.spender");
  expect(withSwapper([...reconsent, swApprove(USDT, other)])).toThrow("consent.spender");
  // 借款幣上別的函式（轉帳）不簽。
  expect(withSwapper([...reconsent, { to: USDC, data: transferData(SWAPPER, 1n) }])).toThrow("consent.to");
  // 一定還是要有 setStrategyPolicy：只有核准不是重新同意。
  expect(withSwapper([swApprove(USDT), swApprove(USDC)])).toThrow("consent.");
});

test("no call to the cash swapper itself is signed in a weight change: topUp, cashOut, setPool", () => {
  const call = (functionName: "topUp" | "cashOut", to = SWAPPER) => ({ to, data: encodeFunctionData({ abi: swapperAbi, functionName, args: [USDC as `0x${string}`, 10n ** 18n, 10n ** 18n, 1_800_000_000n] }) });
  const setPool = { to: SWAPPER, data: encodeFunctionData({ abi: swapperAbi, functionName: "setPool", args: [USDC as `0x${string}`, "0x000000000000000000000000000000000000dEaD"] }) };
  for (const extra of [call("topUp"), call("cashOut"), setPool, { to: SWAPPER, data: approveData(V2.executor) }, delegate(SWAPPER, "setAuthorization", V2.executor)]) {
    expect(withSwapper([...swTail, extra])).toThrow("consent.swapper");
    // 沒宣告時也一樣不簽。
    expect(withSwapper([...reconsent, extra], V2)).toThrow("consent.swapper");
  }
  // 宣告的 swapper 不是釘住的那個：給它的呼叫一樣不簽。
  const other = "0x00000000000000000000000000000000000000d1";
  expect(withSwapper([...reconsent, call("topUp", other)], { ...V2, cashSwapper: other })).toThrow("consent.swapper");
});

test("the declared cash swapper must be a third new address; the pinned swapper is never accepted as the v2 registry or executor", () => {
  for (const cashSwapper of ["0x12", 7, {}, V2.registry, V2.executor, EXECUTOR, REGISTRY, SE.executor, SE.vault, NVDAB, USDT, USDC]) {
    expect(withSwapper(swTail, { ...V2, cashSwapper })).toThrow("strategyV2");
  }
  // 把釘住的 swapper（帳戶之後會核准 USDT 給它）或借款幣宣告成 v2 的 executor／registry：不簽。
  for (const strategyV2 of [{ registry: V2.registry, executor: SWAPPER }, { registry: SWAPPER, executor: V2.executor }, { registry: V2.registry, executor: USDC }, { registry: USD1, executor: V2.executor }]) {
    expect(withSwapper(reconsent, strategyV2)).toThrow("strategyV2");
  }
  // null 當成沒宣告。
  expect(withSwapper(reconsent, { ...V2, cashSwapper: null })().strategyV2).toEqual(V2);
});

test("the cash swapper is checked on-chain before signing: its executor(), borrowRegistry() and usdt() are the set already verified", async () => {
  const chain = (over: Partial<Record<"executor" | "borrowRegistry" | "usdt", unknown>> = {}): MixChainRead => async (call) => {
    if (call.functionName === "allowance") return 2n ** 256n - 1n;
    if (call.address === V2.registry) { expect(call.functionName).toBe("executor"); return "0x494C106498e8221D3f72474f36995C191ACf6bB5"; }
    expect(call.address).toBe(SWAPPER);
    const values: Record<string, unknown> = { executor: "0x494C106498e8221D3f72474f36995C191ACf6bB5", borrowRegistry: "0x7eae73a76Ff2359fE1aB059A77Dd36840A32559E", usdt: USDT, ...over };
    const value = values[call.functionName];
    if (value instanceof Error) throw value;
    return value;
  };
  const checked = { ...V2, cashSwapper: SWAPPER };
  await assertStrategyV2(checked, ACCOUNT, USDT, chain());
  // 沒有核准給 swapper 的那一組不讀 swapper。
  await assertStrategyV2(V2, ACCOUNT, USDT, async (call) => { if (call.address === SWAPPER) throw new Error("must not read the swapper"); return chain()(call); });
  // swapper 綁的是別的 executor／registry（換了 v2 合約組、App 還釘著舊的），或用的不是地址簿的 USDT。
  await expect(assertStrategyV2(checked, ACCOUNT, USDT, chain({ executor: "0x000000000000000000000000000000000000dEaD" }))).rejects.toThrow("consent.v2 swapper");
  await expect(assertStrategyV2(checked, ACCOUNT, USDT, chain({ borrowRegistry: "0x000000000000000000000000000000000000dEaD" }))).rejects.toThrow("consent.v2 swapper");
  await expect(assertStrategyV2(checked, ACCOUNT, USDT, chain({ usdt: USDC }))).rejects.toThrow("consent.v2 swapper");
  await expect(assertStrategyV2(checked, ACCOUNT, USDT, chain({ usdt: undefined }))).rejects.toThrow("consent.v2 swapper");
  // 讀不到就不簽。
  await expect(assertStrategyV2(checked, ACCOUNT, USDT, chain({ borrowRegistry: new Error("rpc down") }))).rejects.toThrow("consent.v2 unreadable");
});

test("the cash swapper is pinned for chain 97 only: USDT from the address book plus USDC, USD1 and U", async () => {
  const { CHAIN } = await import("../src/lib/kernel");
  const b = mixCallBook();
  if (CHAIN.id !== 97) { expect(b.cashSwapper).toBeUndefined(); return; }
  expect(b.cashSwapper?.address).toBe(SWAPPER);
  expect([...(b.cashSwapper?.tokens ?? [])].sort()).toEqual([CHAIN.contracts!.usdt.toLowerCase(), USDC, USD1, U].sort());
  // 釘住的地址不跟 App 已知的合約或資產撞（否則宣告會被當成已知地址擋下）。
  for (const a of [SWAPPER, USDC, USD1, U]) expect(b.assets.has(a) || a === b.registry || a === b.executor).toBe(false);
});

test("the chain 97 call book carries the 31 yield strategy markets (leveraged ones excluded)", () => {
  const b = mixCallBook();
  if (b.strategy === undefined) return; // built for another chain
  expect(b.strategy.markets.size).toBe(31);
  expect(b.strategy.executor).toBe(SE.executor);
});
