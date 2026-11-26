import { expect, test } from "bun:test";
import fs from "node:fs";
import { parseEther } from "viem";
import { BACKEND_GAS_TOPUP_BELOW_WEI, OWNER_GAS_NEEDED_WEI, OwnerGasError, defaultPayWith, ensureOwnerGas, walletBuyMinimum, walletBuyProblem } from "../src/lib/testnet-wallet-buy";

// cre8-app#114：測試網也可以用錢包裡的 USDT 買（例如賣出後回到錢包的 5000）。

test("default: wallet USDT when there is a balance, free test USDT otherwise", () => {
  expect(defaultPayWith(parseEther("5000"))).toBe("wallet");
  expect(defaultPayWith(0n)).toBe("faucet");
  expect(defaultPayWith(null)).toBe("faucet");
});

test("amount checks: minimum and wallet balance, silent while empty", () => {
  const base = { decimals: 18, walletUsdt: parseEther("5000"), minimum: 50 };
  expect(walletBuyProblem({ ...base, amount: "" })).toBeNull();
  expect(walletBuyProblem({ ...base, amount: "49.99" })).toBe("The minimum is 50 USDT.");
  expect(walletBuyProblem({ ...base, amount: "50" })).toBeNull();
  expect(walletBuyProblem({ ...base, amount: "5000" })).toBeNull();
  expect(walletBuyProblem({ ...base, amount: "5000.01" })).toBe("This amount exceeds your wallet balance.");
  expect(walletBuyProblem({ ...base, amount: "1.2.3" })).toBe("Enter a valid amount.");
  // 最低金額跟後端同一套算法；沒有配置時是最小認購 50。
  expect(walletBuyMinimum(undefined, "0xusdt")).toBe(50);
  expect(walletBuyMinimum([{ address: "0xa", weightBps: 1000 }, { address: "0xusdt", weightBps: 9000 }], "0xUSDT")).toBe(100);
});

test("the frontend asks for gas only below the backend's own top-up threshold, so a request is always honoured", () => {
  expect(OWNER_GAS_NEEDED_WEI).toBe(parseEther("0.00005"));
  expect(OWNER_GAS_NEEDED_WEI < BACKEND_GAS_TOPUP_BELOW_WEI).toBe(true);
  // 一筆 transfer 約 0.000005 tBNB：門檻至少夠付好幾筆。
  expect(OWNER_GAS_NEEDED_WEI >= parseEther("0.000005") * 5n).toBe(true);
});

test("network fee: enough → no request; short → ask the backend, wait, re-check; still short → nothing is sent", async () => {
  let asked = 0;
  expect(await ensureOwnerGas({ readBalance: async () => OWNER_GAS_NEEDED_WEI, requestGas: async () => { asked++; return { txHash: "0x1" }; }, waitForTx: async () => {} })).toBe("enough");
  expect(asked).toBe(0);

  let balance = 0n; const waited: string[] = [];
  expect(await ensureOwnerGas({
    readBalance: async () => balance,
    requestGas: async () => { balance = parseEther("0.002"); return { txHash: "0xgas" }; },
    waitForTx: async (hash) => { waited.push(hash); },
  })).toBe("topped-up");
  expect(waited).toEqual(["0xgas"]);

  await expect(ensureOwnerGas({ readBalance: async () => 0n, requestGas: async () => ({ txHash: null }), waitForTx: async () => {} })).rejects.toBeInstanceOf(OwnerGasError);
  await expect(ensureOwnerGas({ readBalance: async () => 0n, requestGas: async () => { throw new Error("503 GAS_FAUCET_DISABLED"); }, waitForTx: async () => {} }))
    .rejects.toThrow("Nothing was transferred.");
});

test("the fund page offers both on testnet and records the wallet transfer as a funding lot", () => {
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("const faucetBuy = testnetPay && payWith === 'faucet';");
  expect(page).toContain("const testnetWalletBuy = testnetPay && payWith === 'wallet';");
  expect(page).toContain('aria-label="Pay with"');
  expect(page).toContain(">Wallet USDT</button>");
  expect(page).toContain(">Free test USDT</button>");
  // 補 gas 一定在錢包轉帳之前；記成投入在確認之後。
  const gas = page.indexOf("requestGas: () => postGasFaucet(token),");
  const transfer = page.indexOf("hash = await sendUsdt(wallet, usdt.address as Address, account as Address, value);");
  expect(gas).toBeGreaterThan(0);
  expect(gas).toBeLessThan(transfer);
  expect(page.indexOf("{ kind: 'wallet_transfer', txHash: hash as string }")).toBeGreaterThan(page.indexOf("transferState = hash === undefined"));
  const api = fs.readFileSync("src/lib/api.ts", "utf8");
  expect(api).toContain("return request('/faucet/gas', { method: 'POST', token, body: {} });");
  expect(api).toContain("{ kind: 'wallet_transfer'; txHash: string }");
});
