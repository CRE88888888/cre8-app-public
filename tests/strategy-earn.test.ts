import { expect, test } from "bun:test";
import { closeRequest, needsRenewal, ownerCalls, sendWithRenewal, type EarnCall, type OwnerCall } from "../src/lib/strategy-earn";

// 加息策略的 owner UserOp（backend strategy-earn，v1 與路由 v2 同一組 endpoint）：calls 原樣送；
// `renewal_required` 時續期接在同一筆最前面（`auto` 與路由 v2 的 `open`）；`exit: true` 只在全部退出時帶。

const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const V2_REGISTRY = "0x7eae73a76ff2359fe1ab059a77dd36840a32559e" as const;
const V2_EXECUTOR = "0x494c106498e8221d3f72474f36995c191acf6bb5" as const;
// 路由 v2 `open` 的 calls：同意（setStrategyPolicy）＋ executeOpen。內容對這裡不重要，重要的是不被改動。
const CALLS: EarnCall[] = [
  { to: V2_REGISTRY, data: "0x1111aaaa", value: "0" },
  { to: V2_EXECUTOR, data: "0x2222bbbb", value: "0" },
];
const RENEWAL = { initConfig: ["0xaaaa0001", "0xaaaa0002"], keyRef: "k/1", permissionId: "0x01" };

function harness(over: { fail?: boolean } = {}) {
  const log: string[] = [];
  const sent: OwnerCall[][] = [];
  return {
    log, sent,
    renewalParams: async () => { log.push("renewal-params"); return RENEWAL; },
    send: async (calls: OwnerCall[]) => { log.push("send"); sent.push(calls); if (over.fail) throw new Error("reverted"); return "0xhash"; },
    recordRenewal: async (p: typeof RENEWAL) => { log.push(`renewal-result ${p.keyRef}`); },
  };
}

test("open with renewal_required: the renewal goes first in the same UserOp, then the backend calls untouched, then it is recorded", async () => {
  const h = harness();
  const hash = await sendWithRenewal({ account: ACCOUNT, quote: { authorization: "renewal_required", calls: CALLS }, ...h });
  expect(hash).toBe("0xhash");
  expect(h.log).toEqual(["renewal-params", "send", "renewal-result k/1"]);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toEqual([
    { to: ACCOUNT, data: "0xaaaa0001", value: 0n },
    { to: ACCOUNT, data: "0xaaaa0002", value: 0n },
    { to: V2_REGISTRY, data: "0x1111aaaa", value: 0n },
    { to: V2_EXECUTOR, data: "0x2222bbbb", value: 0n },
  ]);
});

test("no renewal asked (v1 open and close have no authorization; v2 says ready): only the calls, nothing else is read or recorded", async () => {
  for (const authorization of [undefined, "ready"]) {
    const h = harness();
    await sendWithRenewal({ account: ACCOUNT, quote: { ...(authorization ? { authorization } : {}), calls: CALLS }, ...h });
    expect(h.log).toEqual(["send"]);
    expect(h.sent[0]).toEqual([{ to: V2_REGISTRY, data: "0x1111aaaa", value: 0n }, { to: V2_EXECUTOR, data: "0x2222bbbb", value: 0n }]);
  }
});

test("a UserOp that fails is not recorded as a renewal", async () => {
  const h = harness({ fail: true });
  await expect(sendWithRenewal({ account: ACCOUNT, quote: { authorization: "renewal_required", calls: CALLS }, ...h })).rejects.toThrow("reverted");
  expect(h.log).toEqual(["renewal-params", "send"]);
});

test("needsRenewal only for renewal_required; call values are parsed as decimal strings", () => {
  expect(needsRenewal({ authorization: "renewal_required" })).toBe(true);
  expect(needsRenewal({ authorization: "ready" })).toBe(false);
  expect(needsRenewal({})).toBe(false);
  expect(ownerCalls(ACCOUNT, [{ to: V2_EXECUTOR, data: "0x00", value: "" }, { to: V2_EXECUTOR, data: "0x01", value: "5" }], null).map((c) => c.value)).toEqual([0n, 5n]);
});

test("close: turning the strategy off sends the assets only; a full exit adds exit: true", () => {
  expect(closeRequest(["NVDAB", "QQQB"])).toEqual({ assets: ["NVDAB", "QQQB"] });
  expect("exit" in closeRequest(["NVDAB"])).toBe(false);
  expect("exit" in closeRequest(["NVDAB"], false)).toBe(false);
  expect(closeRequest(["NVDAB", "QQQB"], true)).toEqual({ assets: ["NVDAB", "QQQB"], exit: true });
});
