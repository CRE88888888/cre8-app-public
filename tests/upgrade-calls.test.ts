import { expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, maxUint256, type Address } from "viem";
import { upgradeDoneMessage, upgradeSummary } from "../src/lib/a10";
import { REGISTRY_ABI, enrollCalldata, upgradeCalls } from "../src/lib/atp-contracts";
import { CHAIN, approveCalldata } from "../src/lib/kernel";

// cre8-app#50：升版到含新資產的版本時，要在同一個 UserOp 裡一起 approve 新資產。
// A3 的重現：v1 = USDT 10 / BTCB 45 / WBNB 45，v2 = USDT 10 / BTCB 30 / WBNB 30 / ETH 30。

const REGISTRY = "0x737b585594DD24F9D5d154Abd1B742CFBE6927C5" as Address;
// 有地址簿的鏈（97）只准對地址簿上的 executor 授權，所以 fixture 跟著鏈走（cre8-app#93）。
const EXECUTOR = (CHAIN.contracts?.executor ?? "0x8fa4b65a2f5b9f6159cb9efe3018873712f985d7") as Address;
const ACCOUNT = "0x8ac8258516d8f4298b1d7629867dd22121e672ed" as Address;
const USDT = "0x55d398326f99059fF775485246999027B3197955" as Address;
const BTCB = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" as Address;
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Address;
const ETH = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" as Address;
const SOL = "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF" as Address;

const v1 = [{ asset: USDT, weightBps: 1000 }, { asset: BTCB, weightBps: 4500 }, { asset: WBNB, weightBps: 4500 }];
const v2 = [{ asset: USDT, weightBps: 1000 }, { asset: BTCB, weightBps: 3000 }, { asset: WBNB, weightBps: 3000 }, { asset: ETH, weightBps: 3000 }];
const plan = (current: typeof v1, latest: typeof v1) =>
  upgradeCalls({ registry: REGISTRY, executor: EXECUTOR, account: ACCOUNT, strategyOnchainId: 1n, current, latest });

test("a version that adds an asset: enroll plus one max approval to the executor, in one batch", () => {
  const { calls, newAssets } = plan(v1, v2);
  expect(newAssets).toEqual([ETH]);
  expect(calls.length).toBe(2);

  // 第一筆：registry.enroll(account, 1)
  expect(calls[0]).toEqual({ to: REGISTRY, data: enrollCalldata(ACCOUNT, 1n), value: 0n });
  const enroll = decodeFunctionData({ abi: REGISTRY_ABI, data: calls[0]!.data });
  expect(enroll.functionName).toBe("enroll");
  expect((enroll.args?.[0] as string).toLowerCase()).toBe(ACCOUNT.toLowerCase());
  expect(enroll.args?.[1]).toBe(1n);

  // 第二筆：ETH.approve(executor, max)
  expect(calls[1]!.to).toBe(ETH);
  expect(calls[1]!.value).toBe(0n);
  const approve = decodeFunctionData({ abi: erc20Abi, data: calls[1]!.data });
  expect(approve.functionName).toBe("approve");
  expect(approve.args?.[0].toLowerCase()).toBe(EXECUTOR.toLowerCase());
  expect(approve.args?.[1]).toBe(maxUint256);
  // 跟建立帳戶、Status 的「Approve N asset」送的是同一段 calldata。
  expect(calls[1]!.data).toBe(approveCalldata(EXECUTOR));
});

test("a version with no new asset: the only call is enroll", () => {
  // 只改權重。
  const reweighted = [{ asset: USDT, weightBps: 2000 }, { asset: BTCB, weightBps: 4000 }, { asset: WBNB, weightBps: 4000 }];
  expect(plan(v1, reweighted)).toEqual({ calls: [{ to: REGISTRY, data: enrollCalldata(ACCOUNT, 1n), value: 0n }], newAssets: [] });
  // 只移除資產。
  const removed = [{ asset: USDT, weightBps: 1000 }, { asset: BTCB, weightBps: 9000 }];
  expect(plan(v1, removed).calls.length).toBe(1);
  expect(plan(v1, removed).newAssets).toEqual([]);
  // 同一份。
  expect(plan(v1, v1).calls.length).toBe(1);
});

test("several new assets get one approval each; removed assets are left alone", () => {
  const v3 = [{ asset: USDT, weightBps: 1000 }, { asset: ETH, weightBps: 4500 }, { asset: SOL, weightBps: 4500 }];
  const { calls, newAssets } = plan(v1, v3);
  expect(newAssets).toEqual([ETH, SOL]);
  expect(calls.map((call) => call.to)).toEqual([REGISTRY, ETH, SOL]);
  // 被移除的 BTCB、WBNB 不會被動到（不撤銷授權：賣掉它們還需要）。
  expect(calls.some((call) => call.to === BTCB || call.to === WBNB)).toBe(false);
});

test("addresses are compared without regard to case, and a repeated asset is approved once", () => {
  const lower = v1.map((row) => ({ ...row, asset: row.asset.toLowerCase() as Address }));
  expect(plan(lower, v1).newAssets).toEqual([]);
  const repeated = [...v1, { asset: ETH, weightBps: 0 }, { asset: ETH.toLowerCase() as Address, weightBps: 0 }];
  expect(plan(v1, repeated).newAssets).toEqual([ETH]);
  expect(plan(v1, repeated).calls.length).toBe(2);
});

test("a new asset with zero weight is still approved (it is on the version's asset list)", () => {
  // 後端會自動補一個 0% 的 USDT（backend#24）；這類資產 executor 也可能要動。
  const withoutUsdt = [{ asset: BTCB, weightBps: 5000 }, { asset: WBNB, weightBps: 5000 }];
  const withUsdt = [...withoutUsdt, { asset: USDT, weightBps: 0 }];
  expect(plan(withoutUsdt, withUsdt).newAssets).toEqual([USDT]);
});

test("the success message says what was approved, and only when something was", () => {
  expect(upgradeDoneMessage(2, [])).toBe("Updated to version 2. The next rebalance moves your holdings to the new weights.");
  expect(upgradeDoneMessage(2, ["ETH"])).toBe(
    "Updated to version 2 and approved ETH for trading. The next rebalance moves your holdings to the new weights.",
  );
  expect(upgradeDoneMessage(3, ["ETH", "SOL"])).toContain("approved ETH and SOL for trading");
  expect(upgradeDoneMessage(3, ["ETH", "SOL", "XRP"])).toContain("approved ETH, SOL and XRP for trading");
});

test("the line under the button says the same signature covers the new assets", () => {
  expect(upgradeSummary([])).toBe("One wallet signature. The next rebalance then trades your holdings to the new weights.");
  expect(upgradeSummary(["ETH"])).toBe(
    "One wallet signature. The next rebalance then trades your holdings to the new weights. The same signature lets the fund trade the new asset: ETH.",
  );
  expect(upgradeSummary(["ETH", "SOL"])).toContain("the new assets: ETH and SOL.");
});
