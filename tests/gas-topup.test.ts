import { expect, test } from "bun:test";
import { CHAIN_ID, sendGasTopUp, type RenewalWallet } from "../src/lib/kernel";

// cre8-app#22：補 gas 的轉帳要等上鏈才回傳，否則下一筆 UserOp 估 gas 時帳戶還是 0 BNB（AA21）。
// 用一個假的 EIP-1193 provider 模擬「送出後要過幾次查詢才有收據」的鏈。

const HASH = `0x${"ab".repeat(32)}` as const;
const OWNER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
const ACCOUNT = "0x000000000000000000000000000000000000dEaD" as const;

function fakeWallet(options: { receiptAfterPolls: number; status?: "0x1" | "0x0" }) {
  const log: string[] = [];
  let polls = 0;
  let block = 100;
  const receipt = () => ({
    transactionHash: HASH,
    transactionIndex: "0x0",
    blockHash: `0x${"cd".repeat(32)}`,
    blockNumber: "0x64",
    from: OWNER,
    to: ACCOUNT,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: options.status ?? "0x1",
    type: "0x0",
  });
  const provider = {
    async request({ method }: { method: string; params?: unknown[] }): Promise<unknown> {
      switch (method) {
        case "eth_chainId":
          return `0x${CHAIN_ID.toString(16)}`;
        case "eth_sendTransaction":
          log.push("sent");
          return HASH;
        case "eth_blockNumber":
          block += 1;
          return `0x${block.toString(16)}`;
        case "eth_getTransactionReceipt":
          polls += 1;
          if (polls <= options.receiptAfterPolls) return null;
          log.push("receipt");
          return receipt();
        case "eth_getTransactionByHash":
          // 真的錢包在交易還沒上鏈時會回一筆 pending 交易（blockNumber 為 null）。
          return {
            hash: HASH, from: OWNER, to: ACCOUNT, nonce: "0x0", value: "0x1", input: "0x", gas: "0x5208",
            gasPrice: "0x1", type: "0x0", blockHash: null, blockNumber: null, transactionIndex: null,
            v: "0x1b", r: "0x1", s: "0x1", chainId: `0x${CHAIN_ID.toString(16)}`,
          };
        case "eth_getBlockByNumber":
          return {
            number: `0x${block.toString(16)}`, hash: `0x${"ef".repeat(32)}`, parentHash: `0x${"00".repeat(32)}`,
            timestamp: "0x1", transactions: [], gasLimit: "0x1", gasUsed: "0x0", miner: OWNER, extraData: "0x",
            logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0",
            size: "0x1", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`,
            transactionsRoot: `0x${"00".repeat(32)}`, sha3Uncles: `0x${"00".repeat(32)}`, mixHash: `0x${"00".repeat(32)}`, uncles: [],
          };
        default:
          return null;
      }
    },
  };
  const wallet: RenewalWallet = { kind: "injected", address: OWNER, provider };
  return { wallet, log, polls: () => polls };
}

test("the top-up does not return before its receipt exists", async () => {
  const chain = fakeWallet({ receiptAfterPolls: 3 });
  const hash = await sendGasTopUp({ wallet: chain.wallet, to: ACCOUNT, valueWei: 5n * 10n ** 15n, pollingIntervalMs: 5 });
  chain.log.push("returned");
  expect(hash).toBe(HASH);
  expect(chain.polls()).toBeGreaterThan(3);
  // 順序：送出 → 看到收據 → 才回到呼叫端（呼叫端下一步就是送 approve UserOp）。
  expect(chain.log.filter((entry, index) => chain.log.indexOf(entry) === index)).toEqual(["sent", "receipt", "returned"]);
});

test("a reverted top-up throws instead of letting the approval run without gas", async () => {
  const chain = fakeWallet({ receiptAfterPolls: 0, status: "0x0" });
  await expect(
    sendGasTopUp({ wallet: chain.wallet, to: ACCOUNT, valueWei: 1n, pollingIntervalMs: 5 }),
  ).rejects.toThrow(/reverted/);
});

test("a receipt that never shows up within the timeout still returns the hash", async () => {
  const chain = fakeWallet({ receiptAfterPolls: Number.POSITIVE_INFINITY });
  const hash = await sendGasTopUp({ wallet: chain.wallet, to: ACCOUNT, valueWei: 1n, pollingIntervalMs: 5, timeoutMs: 60 });
  expect(hash).toBe(HASH);
  expect(chain.log).toEqual(["sent"]);
});
