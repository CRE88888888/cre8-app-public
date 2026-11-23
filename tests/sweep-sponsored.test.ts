import { expect, test } from "bun:test";
import type { Address } from "viem";
import { sweepCalls, transferCalldata } from "../src/lib/kernel";

const recipient = "0x1111111111111111111111111111111111111111" as Address;
const usdt = "0x2222222222222222222222222222222222222222" as Address;
const btcb = "0x3333333333333333333333333333333333333333" as Address;
const balances = [
  { asset: usdt, amountWei: 5_000_000_000_000_000_000n },
  { asset: btcb, amountWei: 0n },
];
const nativeWei = 1_000_000_000_000_000n;

test("a sponsored sweep never carries native value (the paymaster rejects value != 0)", () => {
  const calls = sweepCalls({ recipient, balances, nativeWei }, true);
  expect(calls).toEqual([{ to: usdt, data: transferCalldata(recipient, balances[0]!.amountWei), value: 0n }]);
  expect(calls.every((call) => call.value === 0n)).toBe(true);
});

test("a sponsored sweep with only BNB left has nothing to send", () => {
  expect(sweepCalls({ recipient, balances: [], nativeWei }, true)).toEqual([]);
});

test("a self-paid sweep still returns the native coin in the same UserOp", () => {
  const calls = sweepCalls({ recipient, balances, nativeWei }, false);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({ to: recipient, data: "0x", value: nativeWei });
});
