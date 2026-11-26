import { expect, test } from "bun:test";
import { encodeFunctionData, encodePacked, getAddress, type Hex } from "viem";
import {
  EXECUTE_REBALANCE_ABI,
  EXECUTE_REBALANCE_SELECTOR,
  KYBERSWAP_ROUTER,
  PANCAKE_UNIVERSAL_ROUTER,
  decodeRebalanceSteps,
  hasVenue,
  tradeRoutes,
  venueName,
  venueSummary,
} from "../src/lib/venues";

// cre8-app#47（A11）：每一步交易顯示走了哪個交易場所。

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const DOGE = "0xbA2aE424d960c26247Dd6c32edC70B295c744C43";
const ETH = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8";
const UNKNOWN_ROUTER = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const symbols: Record<string, string> = { [USDT.toLowerCase()]: "USDT", [DOGE.toLowerCase()]: "DOGE", [ETH.toLowerCase()]: "ETH" };
const symbolOf = (asset: string) => symbols[asset.toLowerCase()] ?? asset;

test("known routers get their name, whatever the letter case", () => {
  expect(venueName(PANCAKE_UNIVERSAL_ROUTER)).toBe("PancakeSwap");
  expect(venueName(PANCAKE_UNIVERSAL_ROUTER.toUpperCase().replace("0X", "0x"))).toBe("PancakeSwap");
  expect(venueName(KYBERSWAP_ROUTER)).toBe("KyberSwap");
  expect(venueName(KYBERSWAP_ROUTER.toLowerCase())).toBe("KyberSwap");
  // issue 指定的 KyberSwap 位址。
  expect(venueName("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5")).toBe("KyberSwap");
});

test("an unknown router shows as a shortened address, not a guess", () => {
  expect(venueName(UNKNOWN_ROUTER)).toBe("0x1111…0582");
});

test("no venue (older backend) or a non-address is 'not known'", () => {
  expect(venueName(undefined)).toBeNull();
  expect(venueName(null)).toBeNull();
  expect(venueName("")).toBeNull();
  expect(venueName("pancake")).toBeNull();
  expect(venueName("0x1234")).toBeNull();
});

test("each step becomes one row; identical rows are merged and counted", () => {
  const rows = tradeRoutes(
    [
      { tokenIn: USDT, tokenOut: DOGE, venue: KYBERSWAP_ROUTER },
      { tokenIn: USDT, tokenOut: ETH, venue: PANCAKE_UNIVERSAL_ROUTER },
      // 分批賣出：同一組重複出現，位址大小寫不同也算同一組。
      { tokenIn: USDT.toLowerCase(), tokenOut: DOGE.toLowerCase(), venue: KYBERSWAP_ROUTER.toLowerCase() },
      // 同一對代幣走另一個場所是另一列。
      { tokenIn: USDT, tokenOut: DOGE, venue: PANCAKE_UNIVERSAL_ROUTER },
      { tokenIn: ETH, tokenOut: USDT, venue: UNKNOWN_ROUTER },
    ],
    symbolOf,
  );
  expect(rows).toEqual([
    { from: "USDT", to: "DOGE", venue: "KyberSwap", count: 2 },
    { from: "USDT", to: "ETH", venue: "PancakeSwap", count: 1 },
    { from: "USDT", to: "DOGE", venue: "PancakeSwap", count: 1 },
    { from: "ETH", to: "USDT", venue: "0x1111…0582", count: 1 },
  ]);
});

test("steps without a venue still list, with the venue left unknown", () => {
  const steps = [{ tokenIn: USDT, tokenOut: DOGE }];
  expect(tradeRoutes(steps, symbolOf)).toEqual([{ from: "USDT", to: "DOGE", venue: null, count: 1 }]);
  expect(hasVenue(steps)).toBe(false);
  expect(venueSummary(steps)).toBeNull();
  expect(hasVenue([])).toBe(false);
  expect(venueSummary([])).toBeNull();
});

test("the one-line summary counts steps per venue", () => {
  const steps = [
    { tokenIn: USDT, tokenOut: DOGE, venue: KYBERSWAP_ROUTER },
    { tokenIn: USDT, tokenOut: ETH, venue: PANCAKE_UNIVERSAL_ROUTER },
    { tokenIn: ETH, tokenOut: USDT, venue: KYBERSWAP_ROUTER },
    { tokenIn: DOGE, tokenOut: USDT, venue: UNKNOWN_ROUTER },
  ];
  expect(hasVenue(steps)).toBe(true);
  expect(venueSummary(steps)).toBe("KyberSwap ×2, PancakeSwap, 0x1111…0582");
});

// ---------------------------------------------------------------------------
// 交易紀錄：從鏈上交易的 calldata 解回 steps
// ---------------------------------------------------------------------------

const ACCOUNT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const OTHER_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const EXECUTOR = "0x3333333333333333333333333333333333333333";

const rebalance = (account: string, steps: { tokenIn: string; tokenOut: string; venue: string; data?: Hex }[]): Hex =>
  encodeFunctionData({
    abi: EXECUTE_REBALANCE_ABI,
    functionName: "executeRebalance",
    args: [
      account as Hex,
      steps.map((step) => ({
        tokenIn: step.tokenIn as Hex,
        tokenOut: step.tokenOut as Hex,
        amountIn: 1_000n * 10n ** 18n,
        amountOutMin: 990n * 10n ** 18n,
        venue: step.venue as Hex,
        data: step.data ?? "0xdeadbeef",
      })),
      1_800_000_000n,
    ],
  });

// 實際上鏈的形狀：bundler 的 EntryPoint v0.7 `handleOps` → UserOp.callData 是 Kernel v3 的
// `execute(mode, executionCalldata)`，single 模式的 executionCalldata = target(20) ‖ value(32) ‖ calldata。
const KERNEL_EXECUTE_ABI = [{
  type: "function", name: "execute", stateMutability: "payable",
  inputs: [{ name: "execMode", type: "bytes32" }, { name: "executionCalldata", type: "bytes" }], outputs: [],
}] as const;
const HANDLE_OPS_ABI = [{
  type: "function", name: "handleOps", stateMutability: "nonpayable",
  inputs: [
    {
      name: "ops", type: "tuple[]",
      components: [
        { name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" },
        { name: "callData", type: "bytes" }, { name: "accountGasLimits", type: "bytes32" },
        { name: "preVerificationGas", type: "uint256" }, { name: "gasFees", type: "bytes32" },
        { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" },
      ],
    },
    { name: "beneficiary", type: "address" },
  ],
  outputs: [],
}] as const;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

const userOp = (sender: string, inner: Hex) => ({
  sender: sender as Hex,
  nonce: 7n,
  initCode: "0x" as Hex,
  callData: encodeFunctionData({
    abi: KERNEL_EXECUTE_ABI,
    functionName: "execute",
    args: [ZERO32, encodePacked(["address", "uint256", "bytes"], [EXECUTOR as Hex, 0n, inner])],
  }),
  accountGasLimits: ZERO32,
  preVerificationGas: 60_000n,
  gasFees: ZERO32,
  paymasterAndData: "0x" as Hex,
  signature: `0x${"ab".repeat(65)}` as Hex,
});
const bundle = (ops: ReturnType<typeof userOp>[]): Hex =>
  encodeFunctionData({ abi: HANDLE_OPS_ABI, functionName: "handleOps", args: [ops, OTHER_ACCOUNT as Hex] });

test("the selector matches the backend's (A11 ABI)", () => {
  expect(EXECUTE_REBALANCE_SELECTOR).toBe("0xc52fc5da");
});

test("steps come back out of a bundler transaction, one venue per step", () => {
  const input = bundle([
    userOp(ACCOUNT, rebalance(ACCOUNT, [
      { tokenIn: USDT, tokenOut: DOGE, venue: PANCAKE_UNIVERSAL_ROUTER },
      // 聚合器的 data 是一大段不透明的位元組，長度不是 32 的倍數也要解得出來。
      { tokenIn: USDT, tokenOut: ETH, venue: KYBERSWAP_ROUTER, data: `0x${"e21fd0e9"}${"11".repeat(333)}` as Hex },
    ])),
  ]);
  const steps = decodeRebalanceSteps(input, ACCOUNT);
  expect(steps).toEqual([
    { tokenIn: USDT, tokenOut: DOGE, venue: getAddress(PANCAKE_UNIVERSAL_ROUTER) },
    { tokenIn: USDT, tokenOut: ETH, venue: KYBERSWAP_ROUTER },
  ]);
  expect(tradeRoutes(steps ?? [], symbolOf)).toEqual([
    { from: "USDT", to: "DOGE", venue: "PancakeSwap", count: 1 },
    { from: "USDT", to: "ETH", venue: "KyberSwap", count: 1 },
  ]);
});

test("a direct call to the executor decodes too", () => {
  const steps = decodeRebalanceSteps(rebalance(ACCOUNT, [{ tokenIn: DOGE, tokenOut: USDT, venue: KYBERSWAP_ROUTER }]), ACCOUNT.toLowerCase());
  expect(steps).toEqual([{ tokenIn: DOGE, tokenOut: USDT, venue: KYBERSWAP_ROUTER }]);
});

test("in a bundle with several accounts, only this account's steps are returned", () => {
  const input = bundle([
    userOp(OTHER_ACCOUNT, rebalance(OTHER_ACCOUNT, [{ tokenIn: USDT, tokenOut: DOGE, venue: PANCAKE_UNIVERSAL_ROUTER }])),
    userOp(ACCOUNT, rebalance(ACCOUNT, [{ tokenIn: USDT, tokenOut: ETH, venue: KYBERSWAP_ROUTER }])),
  ]);
  expect(decodeRebalanceSteps(input, ACCOUNT)).toEqual([{ tokenIn: USDT, tokenOut: ETH, venue: KYBERSWAP_ROUTER }]);
  expect(decodeRebalanceSteps(input, OTHER_ACCOUNT)).toEqual([
    { tokenIn: USDT, tokenOut: DOGE, venue: getAddress(PANCAKE_UNIVERSAL_ROUTER) },
  ]);
  // 這筆交易裡沒有這個帳戶。
  expect(decodeRebalanceSteps(input, EXECUTOR)).toBeNull();
});

test("transactions that are not a rebalance decode to nothing", () => {
  // 一般的 ERC-20 transfer（提領、掃回）。
  const transfer = "0xa9059cbb00000000000000000000000090f79bf6eb2c4f870365e785982e1f101e93b9060000000000000000000000000000000000000000000000000de0b6b3a7640000";
  expect(decodeRebalanceSteps(transfer, ACCOUNT)).toBeNull();
  expect(decodeRebalanceSteps("0x", ACCOUNT)).toBeNull();
  expect(decodeRebalanceSteps("not hex", ACCOUNT)).toBeNull();
  expect(decodeRebalanceSteps(rebalance(ACCOUNT, []), "not an address")).toBeNull();
});

test("four bytes that only look like the selector are skipped", () => {
  const selector = EXECUTE_REBALANCE_SELECTOR.slice(2);
  const real = rebalance(ACCOUNT, [{ tokenIn: USDT, tokenOut: DOGE, venue: KYBERSWAP_ROUTER }]);
  // 前面放一段剛好含有 selector 的垃圾（位元組對齊與不對齊各一），真的 calldata 在後面。
  const input = `0x${"00".repeat(8)}${selector}${"ff".repeat(40)}0${selector}0${"00".repeat(3)}${real.slice(2)}`;
  expect(decodeRebalanceSteps(input, ACCOUNT)).toEqual([{ tokenIn: USDT, tokenOut: DOGE, venue: KYBERSWAP_ROUTER }]);
  // 只有垃圾、沒有真的 calldata。
  expect(decodeRebalanceSteps(`0x${selector}${"ff".repeat(40)}`, ACCOUNT)).toBeNull();
});
