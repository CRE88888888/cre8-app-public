import { afterEach, expect, test } from "bun:test";
import { confirmEnrollment, prepareEnrollment } from "../src/lib/api";
import { FOLLOW_VERSIONS_TERMS_HASH } from "../src/lib/atp-contracts";
import { AccountNotReadyError, EnrollmentPreparationError, preparationReady, waitForAccountCode, waitForPreparation } from "../src/lib/first-enroll";

// 總管 2026-11-16 更正（backend#126）：後端先由 operator 部署帳戶，202 = 還沒好；前端不帶 initCode。

const ACCOUNT = "0x8ac8258516d8f4298b1d7629867dd22121e672ed";
const noWait = async () => {};
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// backend#126 的 200（chain 97）：每一項都要對。
const CONFIG = `0x${"ab".repeat(32)}`;
const READY = { account: ACCOUNT, accountDeployed: true, expectedVersion: 2, configHash: CONFIG, termsHash: FOLLOW_VERSIONS_TERMS_HASH, performanceFeeBps: 500, activeAt: "2026-11-17T10:01:00.000Z", signingMode: "sudo" };
const PREPARED = { account: ACCOUNT, expectedVersion: 2, configHash: CONFIG, performanceFeeBps: 500, activeAt: "2026-11-17T10:01:00.000Z" };

test("ready only on 200 with accountDeployed true and every required field; 202 waits; anything else stops", () => {
  expect(preparationReady(200, READY)).toEqual(PREPARED);
  expect(preparationReady(202, READY)).toBeNull();
  // 審查 #95 第 5 項：200 卻沒說已部署、欄位缺漏或不合規，一律停（丟錯），不重試、不簽。
  const broken: Record<string, unknown>[] = [
    { ...READY, accountDeployed: undefined }, { ...READY, accountDeployed: false }, { ...READY, accountDeployed: "true" },
    { ...READY, account: "0x123" }, { ...READY, expectedVersion: undefined }, { ...READY, expectedVersion: 0 },
    { ...READY, expectedVersion: 65_536 }, { ...READY, expectedVersion: 1.5 }, { ...READY, expectedVersion: "2" },
    { ...READY, configHash: "0x12" }, { ...READY, termsHash: `0x${"00".repeat(32)}` }, { ...READY, performanceFeeBps: -1 },
    { ...READY, performanceFeeBps: 10_001 }, { ...READY, activeAt: "soon" }, { ...READY, activeAt: undefined },
  ];
  for (const body of broken) expect(() => preparationReady(200, body)).toThrow(EnrollmentPreparationError);
  expect(preparationReady(200, { ...READY, expectedVersion: 65_535 })?.expectedVersion).toBe(65_535);
  expect(() => preparationReady(200, null)).toThrow(EnrollmentPreparationError);
  expect(() => preparationReady(500, READY)).toThrow(EnrollmentPreparationError);
});

test("202 is retried with the same request until the backend says the account is deployed", async () => {
  const answers = [{ status: 202, body: { accountDeployed: false } }, { status: 202, body: { state: "deploying" } }, { status: 200, body: READY }];
  let calls = 0;
  const waits: number[] = [];
  const prepared = await waitForPreparation(async () => answers[calls++]!, { wait: async (ms) => void waits.push(ms) });
  expect(prepared).toEqual(PREPARED);
  expect(calls).toBe(3);
  expect(waits).toEqual([3_000, 3_000]);
  await expect(waitForPreparation(async () => ({ status: 202, body: {} }), { attempts: 3, wait: noWait })).rejects.toBeInstanceOf(AccountNotReadyError);
});

test("the account code must be visible on chain before anything is signed", async () => {
  let reads = 0;
  await waitForAccountCode(async () => (++reads < 3 ? "0x" : "0x6080"), ACCOUNT as `0x${string}`, { wait: noWait });
  expect(reads).toBe(3);
  await expect(waitForAccountCode(async () => undefined, ACCOUNT as `0x${string}`, { attempts: 2, wait: noWait })).rejects.toBeInstanceOf(AccountNotReadyError);
  await expect(waitForAccountCode(async () => { throw new Error("rpc"); }, ACCOUNT as `0x${string}`, { attempts: 2, wait: noWait })).rejects.toBeInstanceOf(AccountNotReadyError);
});

test("prepare reports the HTTP status; confirm posts to enrollment-confirm", async () => {
  const seen: { url: string; body: unknown }[] = [];
  let status = 202;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ account: ACCOUNT, id: 9, smartAccounts: [{ address: ACCOUNT }] }), { status });
  }) as typeof fetch;
  expect((await prepareEnrollment("t", 5)).status).toBe(202);
  status = 200;
  expect((await prepareEnrollment("t", 5)).status).toBe(200);
  expect((await confirmEnrollment("t", 5)).id).toBe(9);
  expect(seen.map((call) => call.url)).toEqual(["/api/portfolios/enrollment-params", "/api/portfolios/enrollment-params", "/api/portfolios/enrollment-confirm"]);
  expect(seen.every((call) => JSON.stringify(call.body) === JSON.stringify({ strategyId: 5 }))).toBe(true);
});
