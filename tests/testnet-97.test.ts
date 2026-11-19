import { expect, test } from "bun:test";
import fs from "node:fs";
import { decodeAbiParameters } from "viem";
import { ApiError } from "../src/lib/api";
import { AddressBookMismatch, chainProfile, checkedContract, isWrongNetwork, walletChainParams } from "../src/lib/chain-config";
import { FAUCET_UNCONFIRMED, FaucetError, faucetFailure, faucetSuccess, formatTestUsdt } from "../src/lib/faucet";
import { SponsorshipError, explainSponsorFailure, packForSponsorship, sponsorshipFromResponse, stubPaymasterData } from "../src/lib/paymaster";
import { TESTNET_97 } from "../src/lib/testnet-97";

// cre8-app#62：前端支援 chain 97（測試網）。

const MAINNET_STRINGS = /\/\/bscscan\.com|bsc-dataseed|^BNB Smart Chain$/;

test("chain 97 is the testnet profile, built from the address book, with nothing borrowed from mainnet", () => {
  const testnet = chainProfile(97);
  expect(testnet).toMatchObject({
    id: 97,
    name: "BNB Smart Chain Testnet",
    testnet: true,
    nativeSymbol: "tBNB",
    explorerUrl: "https://testnet.bscscan.com",
    sponsored: true,
  });
  expect(testnet.contracts).toEqual({
    registry: TESTNET_97.contracts.registry,
    executor: TESTNET_97.contracts.executor,
    usdt: TESTNET_97.contracts.usdt,
    paymaster: TESTNET_97.contracts.paymaster,
    entryPoint: TESTNET_97.contracts.entryPoint,
  });
  // 沒有任何欄位是主網的值。
  for (const value of [testnet.name, testnet.rpcUrl, testnet.explorerUrl ?? ""]) expect(value).not.toMatch(MAINNET_STRINGS);
  expect(testnet.rpcUrl).toContain("testnet");
  // 給了 RPC 就用它；相對路徑（dev 的 /rpc proxy）不能給錢包用，忽略。
  expect(chainProfile(97, "https://rpc.example/97").rpcUrl).toBe("https://rpc.example/97");
  expect(chainProfile(97, "/rpc").rpcUrl).toBe(testnet.rpcUrl);
});

test("chain 56 is unchanged: mainnet name, RPC, explorer, no sponsorship, no address book", () => {
  expect(chainProfile(56)).toEqual({
    id: 56,
    name: "BNB Smart Chain",
    testnet: false,
    nativeSymbol: "BNB",
    rpcUrl: "https://bsc-dataseed.binance.org",
    explorerUrl: "https://bscscan.com",
    sponsored: false,
    faucetFunded: false,
    contracts: null,
  });
  // 加到錢包的參數與原本寫死的那一組相同。
  expect(walletChainParams(chainProfile(56))).toEqual({
    chainName: "BNB Smart Chain",
    rpcUrls: ["https://bsc-dataseed.binance.org"],
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    blockExplorerUrls: ["https://bscscan.com"],
  });
});

test("a local fork is its own profile and never points at mainnet", () => {
  const local = chainProfile(1337);
  expect(local).toMatchObject({ id: 1337, name: "CRE8 Local (1337)", testnet: false, sponsored: false, explorerUrl: null, contracts: null });
  expect(local.rpcUrl).toBe("http://127.0.0.1:8545");
  expect(walletChainParams(local).blockExplorerUrls).toBeUndefined();
});

test("the address book records where it came from and holds well-formed addresses", () => {
  expect(TESTNET_97.chainId).toBe(97);
  expect(TESTNET_97.source.repo).toBe("CRE8Finance/cre8-contracts");
  expect(TESTNET_97.source.path).toBe("deployments/testnet-97.json");
  expect(TESTNET_97.source.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(TESTNET_97.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  const addresses = [...Object.values(TESTNET_97.contracts), ...Object.values(TESTNET_97.assets)];
  for (const address of addresses) expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // 測試 USDT 之外 92 個模擬資產（cre8-contracts#43），地址不重複。
  expect(Object.keys(TESTNET_97.assets).length).toBe(92);
  expect(new Set(addresses.map((address) => address.toLowerCase())).size).toBe(addresses.length);
  expect(TESTNET_97.contracts.entryPoint).toBe("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
});

test("on the testnet a server-reported contract must match the address book", () => {
  const testnet = chainProfile(97);
  const executor = TESTNET_97.contracts.executor;
  expect(checkedContract(testnet, "executor", executor.toLowerCase())).toBe(executor.toLowerCase());
  // 後端指到別的 executor（例如主網的）：停下。
  const other = "0x1111111111111111111111111111111111111111";
  expect(() => checkedContract(testnet, "executor", other)).toThrow(AddressBookMismatch);
  expect(() => checkedContract(testnet, "registry", executor)).toThrow("nothing was sent");
  // 畫面上：白話的一句，兩個地址收在細節裡。
  let caught: unknown;
  try { checkedContract(testnet, "executor", other); } catch (error) { caught = error; }
  expect((caught as AddressBookMismatch).title).toBe("Network setup problem");
  expect((caught as AddressBookMismatch).message).not.toContain("0x");
  expect((caught as AddressBookMismatch).technical).toBe(`executor: server reported ${other}, address book has ${executor}`);
  // 主網與本機 fork 沒有地址簿：照舊放行。
  expect(checkedContract(chainProfile(56), "executor", other)).toBe(other);
  expect(checkedContract(chainProfile(1337), "executor", other)).toBe(other);
});

test("wrong network: only a known, different chain counts", () => {
  const testnet = chainProfile(97);
  expect(isWrongNetwork(testnet, 56)).toBe(true);
  expect(isWrongNetwork(testnet, 97)).toBe(false);
  // 讀不到錢包的鏈：不知道，不算錯。
  expect(isWrongNetwork(testnet, null)).toBe(false);
});

// ---- 代付 ----

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const prepared = {
  sender: SENDER,
  nonce: 7n,
  callData: "0xdeadbeef" as const,
  callGasLimit: 300_000n,
  verificationGasLimit: 150_000n,
  preVerificationGas: 60_000n,
  maxFeePerGas: 100_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
};

test("packs a prepared UserOp the way the backend's /paymaster/sponsor expects (EntryPoint v0.7)", () => {
  const packed = packForSponsorship(prepared);
  expect(packed).toEqual({
    sender: SENDER,
    nonce: "7",
    initCode: "0x",
    callData: "0xdeadbeef",
    // verificationGasLimit（高 16 bytes）‖ callGasLimit（低 16 bytes）
    accountGasLimits: `0x${(150_000).toString(16).padStart(32, "0")}${(300_000).toString(16).padStart(32, "0")}`,
    preVerificationGas: "60000",
    // maxPriorityFeePerGas ‖ maxFeePerGas
    gasFees: `0x${(100_000_000).toString(16).padStart(32, "0")}${(100_000_000).toString(16).padStart(32, "0")}`,
    paymasterAndData: "0x",
    signature: "0x",
  });
  // 只有後端認得的九個欄位（多一個就會被拒）。
  expect(Object.keys(packed).sort()).toEqual(["accountGasLimits", "callData", "gasFees", "initCode", "nonce", "paymasterAndData", "preVerificationGas", "sender", "signature"]);
  // 第一筆（帳戶還沒部署）：initCode = factory ‖ factoryData。
  const factory = "0x2222222222222222222222222222222222222222" as const;
  expect(packForSponsorship({ ...prepared, factory, factoryData: "0xabcd" }).initCode).toBe(`${factory}abcd`);
});

test("sponsorship is never requested before gas is estimated", () => {
  expect(() => packForSponsorship({ ...prepared, callGasLimit: undefined })).toThrow("not fully prepared");
  expect(() => packForSponsorship({ ...prepared, maxFeePerGas: undefined })).toThrow("not fully prepared");
});

test("the estimation stub looks like real paymaster data but can never be valid", () => {
  const paymaster = TESTNET_97.contracts.paymaster;
  const stub = stubPaymasterData(paymaster);
  expect(stub.paymaster).toBe(paymaster);
  expect(stub.paymasterVerificationGasLimit).toBe(100_000n);
  expect(stub.paymasterPostOpGasLimit).toBe(0n);
  // uint48 ×2（各佔一個 32-byte word）＋ 65 bytes 簽名。
  expect((stub.paymasterData.length - 2) / 2).toBe(64 + 65);
  expect(decodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], `0x${stub.paymasterData.slice(2, 130)}`)).toEqual([0, 0]);
});

test("a sponsor response is only used when it names the address-book paymaster", () => {
  const paymaster = TESTNET_97.contracts.paymaster;
  const body = { paymaster: paymaster.toLowerCase(), paymasterData: "0x1234", paymasterVerificationGasLimit: "0x186a0", paymasterPostOpGasLimit: "0x0", validUntil: 1794614400 };
  expect(sponsorshipFromResponse(body, paymaster)).toEqual({ paymaster, paymasterData: "0x1234", paymasterVerificationGasLimit: 100_000n, paymasterPostOpGasLimit: 0n });
  expect(() => sponsorshipFromResponse({ ...body, paymaster: SENDER }, paymaster)).toThrow(SponsorshipError);
  expect(() => sponsorshipFromResponse({ ...body, paymasterData: "nope" }, paymaster)).toThrow(SponsorshipError);
  expect(() => sponsorshipFromResponse({ ...body, paymasterVerificationGasLimit: "abc" }, paymaster)).toThrow(SponsorshipError);
});

test("every rejection reads as plain English and never tells the user to add BNB", () => {
  const cases: [string, number, string][] = [
    // issue 指定的三種。
    ["PAYMASTER_CALL_FORBIDDEN", 403, "not covered by CRE8’s free network fees"],
    ["PAYMASTER_QUOTA_EXCEEDED", 429, "allowance is used up"],
    ["PAYMASTER_DEPOSIT_INSUFFICIENT", 503, "needs a top-up on our side"],
    // 其餘後端會回的代碼（backend#68）。
    ["PAYMASTER_SENDER_FORBIDDEN", 403, "not set up for free network fees"],
    ["PAYMASTER_ACCOUNT_UNDEPLOYED", 403, "not set up for free network fees"],
    ["PAYMASTER_FACTORY_FORBIDDEN", 403, "not set up for free network fees"],
    ["PAYMASTER_EXPIRED", 400, "could not be prepared in time"],
    ["PAYMASTER_RESERVATION_CONFLICT", 409, "could not be prepared in time"],
    ["PAYMASTER_INVALID_OPERATION", 400, "could not be prepared in time"],
    ["PAYMASTER_DISABLED", 503, "not available right now"],
    ["PAYMASTER_DEPENDENCY_UNAVAILABLE", 503, "not available right now"],
    ["PAYMASTER_CHAIN_MISMATCH", 503, "not available right now"],
    ["PAYMASTER_ADDRESS_MISMATCH", 0, "not available right now"],
    ["UNAUTHORIZED", 401, "session has expired"],
    ["RATE_LIMITED", 429, "Too many requests"],
    ["NETWORK", 0, "could not be reached"],
    ["SOMETHING_NEW", 500, "not available right now"],
  ];
  for (const [code, status, text] of cases) {
    const message = explainSponsorFailure(code, status);
    expect([code, message.includes(text)]).toEqual([code, true]);
    expect(message).toContain("Nothing was sent.");
    // 不可以出現代碼，也不可以叫使用者去補 BNB。
    expect(message).not.toMatch(/PAYMASTER_|[A-Z]{3,}_[A-Z]/);
    expect(message).not.toMatch(/add (some |more )?t?BNB to|top up your|fund your (wallet|account)|buy t?BNB/i);
  }
  // 三種主要的拒絕都明講「不用自己補」。
  for (const code of ["PAYMASTER_CALL_FORBIDDEN", "PAYMASTER_QUOTA_EXCEEDED", "PAYMASTER_DEPOSIT_INSUFFICIENT"]) {
    expect(explainSponsorFailure(code, 403)).toContain("You do not need to add BNB yourself.");
  }
});

test("a sponsor rejection becomes an error the page can show, with the raw answer kept aside", () => {
  const error = SponsorshipError.from(new ApiError(429, "PAYMASTER_QUOTA_EXCEEDED", "paymaster sponsorship rejected: PAYMASTER_QUOTA_EXCEEDED"));
  expect(error).toBeInstanceOf(Error);
  expect(error.title).toBe("Network fee not covered");
  expect(error.code).toBe("PAYMASTER_QUOTA_EXCEEDED");
  expect(error.message).toContain("allowance is used up");
  expect(error.technical).toBe("429 · PAYMASTER_QUOTA_EXCEEDED\npaymaster sponsorship rejected: PAYMASTER_QUOTA_EXCEEDED");
  // 已經是 SponsorshipError 就原樣回傳。
  expect(SponsorshipError.from(error)).toBe(error);
  expect(SponsorshipError.from(new ApiError(0, "NETWORK", "Failed to fetch")).message).toContain("could not be reached");
  expect(SponsorshipError.from(new Error("boom")).code).toBe("PAYMASTER_BAD_RESPONSE");
});

// ---- 領測試 USDT ----

test("claiming test USDT: the outcomes match the backend's implementation (backend#72)", () => {
  expect(formatTestUsdt("1000000000000000000000")).toBe("1,000");
  expect(formatTestUsdt("500000000000000000000")).toBe("500");
  expect(formatTestUsdt(undefined)).toBeNull();
  expect(formatTestUsdt("1e21")).toBeNull();

  // 200：回應帶 state、amountWei、txHash；錢進的是基金帳戶，不是錢包。
  expect(faucetSuccess({ state: "confirmed", amountWei: "1000000000000000000000", txHash: "0xabc" })).toEqual({
    kind: "claimed",
    amount: "1,000 test USDT",
    message: "1,000 test USDT is on its way to this fund’s account. Test tokens have no value.",
    settled: true,
    txHash: "0xabc",
  });
  expect(faucetSuccess({})).toMatchObject({ kind: "claimed", amount: "Test USDT", settled: true, txHash: null });
  // 202：結果未知。不能當成已經到帳。
  const unknown = faucetSuccess({ state: "unknown", amountWei: "1000000000000000000000", txHash: "0xabc" });
  expect(unknown).toMatchObject({ kind: "claimed", settled: false, txHash: "0xabc" });
  expect(unknown.message).toContain("has not confirmed it yet");
  expect(unknown.message).not.toContain("on its way");

  // 後端實作的錯誤代碼。
  expect(faucetFailure(new ApiError(429, "FAUCET_QUOTA_EXCEEDED", "x"))).toEqual({
    kind: "quota",
    message: "You have already claimed today’s 1,000 test USDT, or today’s total for everyone has run out. Come back tomorrow (after 00:00 UTC).",
  });
  expect(faucetFailure(new ApiError(429, "FAUCET_RECIPIENT_LIMIT", "x"))).toEqual({
    kind: "limit",
    message: "This fund’s account has received as much test USDT as it can in 24 hours. Try again later.",
  });
  expect(faucetFailure(new ApiError(403, "FAUCET_ACCOUNT_FORBIDDEN", "x"))).toEqual({
    kind: "forbidden",
    message: "Test USDT can only go to a fund account you have joined. Reload the page, then try again.",
  });
  for (const code of ["FAUCET_DISABLED", "FAUCET_CHAIN_MISMATCH"]) {
    expect(faucetFailure(new ApiError(503, code, "x"))).toEqual({
      kind: "unavailable",
      message: "Test USDT is not set up on this network. Please let the team know.",
    });
  }
  for (const code of ["FAUCET_STORAGE_UNAVAILABLE", "FAUCET_OPERATOR_UNAVAILABLE", "FAUCET_PREPARE_UNAVAILABLE"]) {
    expect(faucetFailure(new ApiError(503, code, "x"))).toEqual({
      kind: "unavailable",
      message: "Test USDT is not available right now. Please try again later.",
    });
  }
  expect(faucetFailure(new ApiError(503, "RELAYER_BUSY", "x"))).toMatchObject({ kind: "unavailable", message: expect.stringContaining("busy") });
  // 502：`state: "failed"` 的結果沒有 error.code，`request` 給的是 HTTP_502。
  expect(faucetFailure(new ApiError(502, "HTTP_502", "Bad Gateway"))).toEqual({
    kind: "failed",
    message: "The test USDT transfer did not go through. Please try again.",
  });

  // 後端之後多了別的代碼也不會變成看不懂的錯誤。
  expect(faucetFailure(new ApiError(409, "CONFLICT", "x")).kind).toBe("quota");
  expect(faucetFailure(new ApiError(429, "FAUCET_ALREADY_CLAIMED", "x")).kind).toBe("quota");
  expect(faucetFailure(new ApiError(429, "RATE_LIMITED", "x"))).toMatchObject({ kind: "unavailable", message: expect.stringContaining("Too many requests") });
  expect(faucetFailure(new ApiError(400, "FAUCET_INVALID_REQUEST", "x"))).toMatchObject({ kind: "unavailable" });
  expect(faucetFailure(new ApiError(404, "NOT_FOUND", "x"))).toMatchObject({ kind: "unavailable" });
  expect(faucetFailure(new ApiError(401, "UNAUTHORIZED", "x"))).toMatchObject({ kind: "signed-out" });
  expect(faucetFailure(new Error("offline"))).toMatchObject({ kind: "unavailable" });
  // 給使用者看的話裡沒有代碼。
  for (const [status, code] of [[429, "FAUCET_QUOTA_EXCEEDED"], [429, "FAUCET_RECIPIENT_LIMIT"], [403, "FAUCET_ACCOUNT_FORBIDDEN"], [503, "FAUCET_DISABLED"], [502, "HTTP_502"]] as const) {
    expect(faucetFailure(new ApiError(status, code, "x")).message).not.toMatch(/FAUCET|HTTP_|[A-Z]{3,}_[A-Z]/);
  }
  expect(FAUCET_UNCONFIRMED.message).not.toMatch(/FAUCET|[A-Z]{3,}_[A-Z]/);
});

test("a failed claim becomes an error the page can show, with the raw answer kept aside", () => {
  const cause = new ApiError(429, "FAUCET_QUOTA_EXCEEDED", "one claim per owner per UTC day; site daily cap also applies");
  const error = new FaucetError(faucetFailure(cause), cause);
  expect(error).toBeInstanceOf(Error);
  expect(error.title).toBe("Test USDT not claimed");
  expect(error.kind).toBe("quota");
  expect(error.message).toContain("Come back tomorrow");
  expect(error.technical).toBe("429 · FAUCET_QUOTA_EXCEEDED\none claim per owner per UTC day; site daily cap also applies");
  expect(new FaucetError(faucetFailure(new Error("x"))).technical).toBe("");
});

test("a claim whose result is unknown is waited for, and never treated as money in the account", () => {
  const fund = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(fund).toContain("claimSettled = claimed.settled;");
  // 沒等到上鏈就停下（return），在要求簽授權之前。
  const stop = fund.indexOf("title: FAUCET_UNCONFIRMED.title");
  expect(stop).toBeGreaterThan(fund.indexOf("await waitForConfirmations(wallet, hash, 2)"));
  expect(stop).toBeLessThan(fund.indexOf("title: 'Preparing fund allocation'"));
  expect(fund.slice(stop, fund.indexOf("if (transferState === 'reverted')", stop))).toContain("return;");
});

test("on the testnet a buy is funded by the faucet, into the fund account, never by a wallet transfer", () => {
  expect(chainProfile(97).faucetFunded).toBe(true);
  expect(chainProfile(56).faucetFunded).toBe(false);
  expect(chainProfile(1337).faucetFunded).toBe(false);
  const fund = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  // 送給水龍頭的是基金帳戶（`account`），不是錢包地址。
  expect(fund).toContain("await postFaucetUsdt(token, account as string)");
  expect(fund).not.toMatch(/postFaucetUsdt\(token, (wallet|walletAddress|connectedAddress)/);
  // 錢包轉 USDT 只在非測試網的分支裡。
  const transfer = fund.indexOf("hash = await sendUsdt(");
  expect(fund.lastIndexOf("} else {", transfer)).toBeGreaterThan(fund.indexOf("if (faucetBuy) {"));
  expect(fund.match(/sendUsdt\(wallet,/g)?.length).toBe(1);
  // 入金方式清單不再有第二顆領取按鈕。
  const list = fs.readFileSync("src/components/FundingMethods.tsx", "utf8");
  expect(list).toContain("CHAIN.faucetFunded ?");
  expect(list).not.toMatch(/postFaucetUsdt|onClick/);
  expect(fs.existsSync("src/components/ClaimTestUsdt.tsx")).toBe(false);
});

// ---- 原始碼守住的幾件事 ----

test("nothing outside the chain config hard-codes mainnet for the wallet, the chain object or explorer links", () => {
  const kernel = fs.readFileSync("src/lib/kernel.ts", "utf8");
  expect(kernel).not.toContain("bsc-dataseed");
  expect(kernel).toContain("chainProfile(CHAIN_ID, import.meta.env.VITE_RPC_URL, import.meta.env.VITE_TESTNET_RPC_URL)");
  const menu = fs.readFileSync("src/components/WalletMenu.tsx", "utf8");
  expect(menu).not.toMatch(/bscscan|bsc-dataseed/);
  expect(menu).toContain("walletChainParams(CHAIN)");
  expect(fs.readFileSync("src/features/fund/FundPage.tsx", "utf8")).not.toContain("bscscan");
  expect(fs.readFileSync("src/lib/use-wallet-diagnostics.ts", "utf8")).toContain("const EXPECTED_CHAIN_ID = CHAIN_ID;");
});

test("the testnet banner and the wrong-network notice only show on the testnet", () => {
  const banners = fs.readFileSync("src/components/NetworkBanners.tsx", "utf8");
  expect(banners).toContain("if (!CHAIN.testnet) return null;");
  expect(banners).toContain("Test tokens only, no real value.");
  expect(banners).toContain("if (!CHAIN.testnet || provider === null || !isWrongNetwork(CHAIN, walletChainId)) return null;");
  const app = fs.readFileSync("src/App.tsx", "utf8");
  expect(app).toContain("<TestnetBanner />");
  expect(app).toContain("<WrongNetworkNotice />");
});

test("sponsorship is only wired in when the chain is sponsored, and gas top-ups are skipped there", () => {
  const kernel = fs.readFileSync("src/lib/kernel.ts", "utf8");
  expect(kernel).toContain("CHAIN.sponsored ? (CHAIN.contracts?.paymaster");
  expect(kernel).toContain("...(paymasterAddress === undefined");
  // 估 gas 的那個 hook 不打後端。
  expect(kernel).toContain("getPaymasterStubData: async () => stubPaymasterData(paymasterAddress)");
  const fund = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(fund).toContain("&& !CHAIN.sponsored) {");
  expect(fund).toContain("if (CHAIN.sponsored) return false;");
});
