import { expect, test } from "bun:test";
import { createPublicClient, http } from "viem";
import { TESTNET_BLOCK_TIME_MS, chainProfile, viemBlockTime } from "../src/lib/chain-config";

// 買入很慢（使用者 2026-11-23）：viem 不知道出塊時間時當成 12 秒，等收據每 4 秒才問一次。
// 測試網 0.45 秒出塊，轉帳早就上鏈了還在等。

const client = (profile: ReturnType<typeof chainProfile>) =>
  createPublicClient({
    chain: { id: profile.id, name: profile.name, nativeCurrency: { name: "t", symbol: "t", decimals: 18 }, rpcUrls: { default: { http: [profile.rpcUrl] } }, ...viemBlockTime(profile) },
    transport: http(profile.rpcUrl),
  });

test("chain 97 tells viem its block time, so receipts are polled every 500ms instead of 4s", () => {
  expect(chainProfile(97).blockTimeMs).toBe(TESTNET_BLOCK_TIME_MS);
  expect(viemBlockTime(chainProfile(97))).toEqual({ blockTime: 450 });
  expect(client(chainProfile(97)).pollingInterval).toBe(500);
});

test("mainnet and the local fork keep viem's default", () => {
  expect(viemBlockTime(chainProfile(56))).toEqual({});
  expect(viemBlockTime(chainProfile(1337))).toEqual({});
  expect(client(chainProfile(56)).pollingInterval).toBe(4_000);
});
