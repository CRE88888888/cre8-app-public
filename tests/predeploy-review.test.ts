/**
 * 部署前審查（cre8-app#93）的 22 項，每項一個回歸測試。編號照 issue 的報告順序：H 是 high、M 是 medium、L 是 low、N 是 nit。
 * 這個檔案在 `bun test` 與 `VITE_CHAIN_ID=97 bun test` 都要過：跟鏈有關的都明確指定鏈。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { ApiError } from "../src/lib/api";
import { APPROVALS_PER_USEROP, ApprovalBatchError, approvalBatches, approvalProgress, sendInBatches, upgradeBatches } from "../src/lib/approval-batches";
import { DEFAULT_CHAIN_ID, RpcChainMismatch, chainProfile, readChainId, readRpcChainId, testnetRpcUrl, verifyRpcChain } from "../src/lib/chain-config";
import { exportDesign } from "../src/lib/design-export";
import { createExchangeGuard } from "../src/lib/exchange-guard";
import {
  CLAIM_UNCONFIRMED_TODAY, afterBuyFunding, dailyClaimAlreadyInvested, claimOutcomeUnknown, faucetBuyMode, forgetResume, hadUnknownClaimToday,
  needsResume, pendingWelcome, rememberPendingWelcome, rememberResume, rememberUnknownClaim, retryClaimLater,
} from "../src/lib/faucet";
import { PERFORMANCE_FEE, designFeeTerms, performanceFeeLine, performanceSplit, swapFeeLabel } from "../src/lib/fees";
import { percentToBps, quantizePercent, stackExecution, zeroBpsAssets } from "../src/lib/fund-execution";
import { cleanDisplayName, graphemes, initialOf } from "../src/lib/profile-name";
import { showCodeStep, trapFocus } from "../src/lib/sign-in-steps";
import { SubscriptionLocked, assertSubscriptionOpen, typedVersionLocked } from "../src/lib/subscription-lock";
import { testnetToken } from "../src/lib/testnet-catalogue";

const read = (file: string): string => fs.readFileSync(file, "utf8");
const FUND_PAGE = read("src/features/fund/FundPage.tsx");
const CREATE_PAGE = read("src/features/create/CreateFundPage.tsx");
const DESIGNER = read("src/features/create/FundDesigner.tsx");

// 這些測試要一個 localStorage（bun 沒有）。
const store = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
// 一律換上自己的（別的測試檔可能留下 `localStorage = undefined`，執行順序在 CI 與本機不同），結束還原。
let previous: unknown;
beforeAll(() => {
  previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = memoryStorage;
});
afterAll(() => { (globalThis as { localStorage?: unknown }).localStorage = previous; });
beforeEach(() => store.clear());

// ---- H1 迎新 202 之後，每次買入先恢復原來那筆 ----

test("H1: after a 202 welcome, the next press asks buy-funding again instead of switching to the daily claim", () => {
  rememberPendingWelcome(7, "41");
  expect(pendingWelcome(7)).toBe("41");
  // 帳戶已經有錢（mint 到了但 grant 還是 unknown），也還在等迎新：仍走 welcome。
  expect(faucetBuyMode({ resume: false, welcomePending: true, welcomeUsed: true })).toBe("welcome");
  // 等到的那一筆（後端對帳後回 replayed lot）算這次的錢，不是「迎新用掉了」。
  expect(afterBuyFunding({ funding: "welcome_grant", lot: { replayed: true } }, true)).toBe("invest");
  expect(afterBuyFunding({ funding: "welcome_grant", lot: { replayed: true } }, false)).toBe("daily");
  expect(afterBuyFunding({ funding: "welcome_grant", lot: { replayed: false } }, false)).toBe("invest");
  expect(afterBuyFunding({ funding: "existing_cash", lot: null }, false)).toBe("existing");
  // 原始碼：buy-funding 在每日領取之前，202 時記下 grantId。
  expect(FUND_PAGE.indexOf("await postBuyFunding(token, target)")).toBeLessThan(FUND_PAGE.indexOf("await postFaucetUsdt(token, account as string)"));
  expect(FUND_PAGE).toContain("rememberPendingWelcome(target, funding.grantId);");
});

// ---- H2 主網鎖住 typed 基金的認購 ----

test("H2: on chain 56 a typed fund cannot be bought before the mainnet funding pipeline is open", async () => {
  const mainnet = chainProfile(56);
  const testnet = chainProfile(97);
  expect(typedVersionLocked(mainnet, [{ version: 1, executionSchemaVersion: 0 }, { version: 2, executionSchemaVersion: 2 }] as never)).toBe(true);
  expect(typedVersionLocked(mainnet, [{ version: 1, executionSchemaVersion: 0 }] as never)).toBe(false);
  expect(typedVersionLocked(testnet, [{ version: 1, executionSchemaVersion: 2 }] as never)).toBe(false);
  await expect(assertSubscriptionOpen(mainnet, async () => ({ automation: "testnet_only" }))).rejects.toBeInstanceOf(SubscriptionLocked);
  await expect(assertSubscriptionOpen(mainnet, async () => ({ automation: "enabled" }))).resolves.toBeUndefined();
  // 舊的目標比例基金沒有 typed 版本：照舊可以買。
  await expect(assertSubscriptionOpen(mainnet, async () => { throw new ApiError(409, "EXECUTION_VERSION_MISMATCH", "x"); })).resolves.toBeUndefined();
  // 讀不到：不轉。
  await expect(assertSubscriptionOpen(mainnet, async () => { throw new ApiError(503, "EXECUTION_STORAGE_UNAVAILABLE", "x"); })).rejects.toBeInstanceOf(SubscriptionLocked);
  // 原始碼：檢查在補 gas 與轉 USDT 之前；新買家在建帳戶之前。
  const check = FUND_PAGE.indexOf("await assertSubscriptionOpen(CHAIN, () => getPortfolioExecution(token, target));");
  expect(check).toBeGreaterThan(0);
  expect(check).toBeLessThan(FUND_PAGE.indexOf("await sendGasTopUp({ wallet, to: account as Address"));
  expect(check).toBeLessThan(FUND_PAGE.indexOf("hash = await sendUsdt(wallet"));
  expect(FUND_PAGE.indexOf("throw new SubscriptionLocked('mainnet');")).toBeLessThan(FUND_PAGE.indexOf("const created = await enrollPortfolio(token, strategy.id);"));
});

// ---- M1 approve 分批（一筆 UserOp 最多 32 個）----

test("M1: approvals go out 32 per user operation, one batch after another, and report progress on failure", async () => {
  expect(APPROVALS_PER_USEROP).toBe(32);
  expect(approvalBatches(Array.from({ length: 32 }, (_, i) => i)).map((b) => b.length)).toEqual([32]);
  expect(approvalBatches(Array.from({ length: 33 }, (_, i) => i)).map((b) => b.length)).toEqual([32, 1]);
  expect(approvalBatches(Array.from({ length: 92 }, (_, i) => i)).map((b) => b.length)).toEqual([32, 32, 28]);
  const sent: number[] = [];
  await sendInBatches(Array.from({ length: 70 }, (_, i) => i), async (batch) => { sent.push(batch.length); });
  expect(sent).toEqual([32, 32, 6]);
  let failure: unknown = null;
  await sendInBatches(Array.from({ length: 70 }, (_, i) => i), async (batch) => { if (batch[0] === 32) throw new Error("403 PAYMASTER"); })
    .catch((cause) => { failure = cause; });
  expect(failure).toBeInstanceOf(ApprovalBatchError);
  expect((failure as ApprovalBatchError).approved).toBe(32);
  expect((failure as ApprovalBatchError).remaining).toBe(38);
  expect(approvalProgress(1, 3, 32)).toBe("Signature 2 of 3 · 32 assets…");
  // 三個入口都分批：首買、補授權、建立頁。
  expect(FUND_PAGE.match(/sendInBatches\(/g)?.length).toBe(2);
  expect(CREATE_PAGE).toContain("await sendInBatches(status.targets,");
  expect(FUND_PAGE).not.toContain("calls: targets.map(");
  expect(CREATE_PAGE).not.toContain("calls: status.targets.map(");
});

// ---- M2 每日投入記帳暫時失敗不丟 claimId ----

test("M2: a daily claim is kept for a retry unless the backend says the source can never be recorded", () => {
  for (const [status, code] of [[0, "NETWORK"], [401, "UNAUTHORIZED"], [429, "RATE_LIMITED"], [500, "INTERNAL"], [503, "X"], [409, "FUNDING_NOT_CONFIRMED"], [409, "PORTFOLIO_BUSY"]] as const) {
    expect(retryClaimLater(new ApiError(status, code, "x"))).toBe(true);
  }
  for (const [status, code] of [[400, "INVALID_FUNDING_SOURCE"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [409, "FUNDING_EVENT_CONFLICT"]] as const) {
    expect(retryClaimLater(new ApiError(status, code, "x"))).toBe(false);
  }
  expect(retryClaimLater(new Error("offline"))).toBe(true);
});

// ---- M3 每日領取的回應遺失 ----

test("M3: a daily claim whose response was lost is remembered, so a same-day 429 explains the money may be there", () => {
  expect(claimOutcomeUnknown(new ApiError(0, "NETWORK", "x"))).toBe(true);
  expect(claimOutcomeUnknown(new ApiError(504, "GATEWAY_TIMEOUT", "x"))).toBe(true);
  expect(claimOutcomeUnknown(new ApiError(429, "FAUCET_QUOTA_EXCEEDED", "x"))).toBe(false);
  expect(claimOutcomeUnknown(new ApiError(502, "", "failed"))).toBe(false);
  const today = new Date("2026-11-16T10:00:00Z");
  rememberUnknownClaim(9, today);
  expect(hadUnknownClaimToday(9, today)).toBe(true);
  expect(hadUnknownClaimToday(9, new Date("2026-11-17T00:00:01Z"))).toBe(false);
  expect(CLAIM_UNCONFIRMED_TODAY.message).toContain("may already be in this fund");
  expect(FUND_PAGE).toContain("outcome.kind === 'quota' && hadUnknownClaimToday(target)");
  // backend#97 的冪等契約：同日重送回原 claim（200＋同 claimId）。沒記過的照常記成投入；記過的（replayed）不算新的錢。
  expect(dailyClaimAlreadyInvested({ replayed: true })).toBe(true);
  expect(dailyClaimAlreadyInvested({ replayed: false })).toBe(false);
  expect(dailyClaimAlreadyInvested({})).toBe(false);
  expect(FUND_PAGE).toMatch(/if \(dailyClaimAlreadyInvested\(lot\)\) \{ alreadyInvested = true; return; \}\s*rememberResume\(target\);\s*funded = true;/);
});

// ---- M1（補）帳戶升版也分批 ----

test("M1: an account upgrade sends approvals 32 at a time and enrolls last", () => {
  const registry = "0xRegistry";
  const enroll = { to: registry, id: "enroll" };
  const approvals = Array.from({ length: 40 }, (_, i) => ({ to: `0xasset${i}`, id: `a${i}` }));
  const batches = upgradeBatches([enroll, ...approvals], registry.toLowerCase());
  expect(batches.map((b) => b.length)).toEqual([32, 9]);
  expect(batches.at(-1)!.at(-1)).toBe(enroll);
  expect(batches.flat().filter((c) => c === enroll)).toHaveLength(1);
  expect(upgradeBatches([enroll, ...approvals.slice(0, 3)], registry).map((b) => b.length)).toEqual([4]);
  const controls = read("src/features/fund/AccountControls.tsx");
  expect(controls).toContain("upgradeBatches(calls, registry)");
  expect(controls).not.toMatch(/sendSudoCalls\(\{\s*wallet,\s*token,\s*accountAddress: account as Address,\s*strategyId: dbStrategyId,\s*calls,\s*\}\)/);
});

// ---- M4 「繼續配置」與「新增每日投入」分開 ----

test("M4: money already recorded but not invested is finished first, without claiming again", () => {
  expect(faucetBuyMode({ resume: true, welcomePending: false, welcomeUsed: true })).toBe("resume");
  expect(faucetBuyMode({ resume: false, welcomePending: false, welcomeUsed: true })).toBe("daily");
  expect(faucetBuyMode({ resume: false, welcomePending: false, welcomeUsed: false })).toBe("welcome");
  rememberResume(3);
  expect(needsResume(3)).toBe(true);
  forgetResume(3);
  expect(needsResume(3)).toBe(false);
  // 不再用總值判斷要不要領每日。
  expect(FUND_PAGE).not.toMatch(/dailyNeeded \|\| \(holding !== undefined && live !== undefined && totalUsd\(\) > 0\)/);
  expect(FUND_PAGE).toContain("buyMode === 'resume' ? 'Finish investing'");
  expect(FUND_PAGE).toContain("if (faucetBuy && settledRound) forgetResume(target);");
});

// ---- M5 夏令時間：先定位日期再設時刻 ----

test("M5: a weekly 02:30 picked in New York on 2026-03-08 is saved as Monday 06:30 UTC", () => {
  const zone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    expect(stackExecution({ every: "weekly", day: 0, time: "02:30", buys: 4 }, new Date(2026, 2, 8, 10))).toMatchObject({ weekday: 1, timeUtc: "06:30" });
    // 當天沒有 02:30（撥快）：往後一週。
    expect(stackExecution({ every: "weekly", day: 6, time: "02:30", buys: 4 }, new Date(2026, 2, 7, 10))).toMatchObject({ weekday: 0, timeUtc: "06:30" });
    // 01:30 出現兩次（撥慢）：用下一天。
    expect(stackExecution({ every: "daily", time: "01:30", buys: 4 }, new Date(2026, 10, 1, 0, 10))).toMatchObject({ timeUtc: "06:30" });
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});

// ---- M6、M7 登入換 session：timeout 與舊請求隔離 ----

test("M6/M7: the session exchange times out, can be cancelled, and a stale request cannot touch the new sign-in", () => {
  const timers: (() => void)[] = [];
  const guard = createExchangeGuard(20_000, { set: (run) => { timers.push(run); return timers.length; }, clear: () => undefined });
  const a = guard.start("user-a");
  expect(guard.busy()).toBe(true);
  timers[0]!();
  expect(a.signal.aborted).toBe(true); // 逾時：請求被 abort
  guard.cancel(); // 登出
  expect(a.isCurrent()).toBe(false);
  expect(guard.busy()).toBe(false);
  const b = guard.start("user-b");
  expect(b.isCurrent()).toBe(true);
  a.done(); // A 稍後才結束：不影響 B
  expect(b.isCurrent()).toBe(true);
  const c = guard.start("user-b"); // 重試
  expect(b.isCurrent()).toBe(false);
  c.done();
  expect(guard.busy()).toBe(false);
  const root = read("src/features/auth/PrivyRoot.tsx");
  expect(root).toContain("postPrivyLogin(identityToken, ticket.signal)");
  expect(root).toMatch(/catch \(cause\) \{\s*\/\/[^\n]*\n\s*if \(!current\(\)\) return;/);
  expect(root).not.toContain("inFlight");
});

// ---- M8 測試網一定用測試網 RPC，交易前驗 chain ID ----

test("M8: chain 97 never reads a mainnet RPC, and transactions stop when the RPC reports another chain", async () => {
  expect(testnetRpcUrl(undefined, "https://bsc-rpc.publicnode.com")).toBe("https://bsc-testnet.publicnode.com");
  expect(testnetRpcUrl(undefined, "https://bsc-dataseed.binance.org")).toBe("https://bsc-testnet.publicnode.com");
  expect(testnetRpcUrl("https://my-testnet.example", "https://bsc-rpc.publicnode.com")).toBe("https://my-testnet.example");
  expect(chainProfile(97, "https://bsc-rpc.publicnode.com").rpcUrl).toBe("https://bsc-testnet.publicnode.com");
  const answer = (result: unknown) => (async () => new Response(JSON.stringify({ result }))) as unknown as typeof fetch;
  expect(await readRpcChainId("https://x", answer("0x61"))).toBe(97);
  await expect(verifyRpcChain(chainProfile(97), answer("0x61"))).resolves.toBeUndefined();
  await expect(verifyRpcChain(chainProfile(97), answer("0x38"))).rejects.toBeInstanceOf(RpcChainMismatch);
  await expect(verifyRpcChain(chainProfile(97), (async () => { throw new Error("down"); }) as unknown as typeof fetch)).rejects.toBeInstanceOf(RpcChainMismatch);
  await expect(verifyRpcChain(chainProfile(1337), answer("0x1"))).resolves.toBeUndefined();
  const kernel = read("src/lib/kernel.ts");
  expect(kernel).toMatch(/export async function sendSudoCalls[\s\S]{0,400}await assertRpcChain\(\);/);
  expect(FUND_PAGE).toMatch(/async function sendUsdt[\s\S]{0,300}await assertRpcChain\(\);/);
});

// ---- M9 寄碼後可以換信箱 ----

test("M9: only a fresh send moves to the code step, so Use another email stays on the email step", () => {
  expect(showCodeStep({ step: "email", emailStep: "awaiting-code-input", requested: false })).toBe(false);
  expect(showCodeStep({ step: "email", emailStep: "awaiting-code-input", requested: true })).toBe(true);
  expect(showCodeStep({ step: "email", emailStep: "sending-code", requested: true })).toBe(false);
  const screen = read("src/components/SignInScreen.tsx");
  expect(screen).toContain("onClick={() => { codeRequested.current = false; setCode(''); setStep('email'); }}");
  expect(screen).not.toContain("if (emailStep === 'awaiting-code-input' && step === 'email') setStep('code');");
});

// ---- M10 費用照參數總表 ----

test("M10: fees follow the fee table: swap max(0.1%, 0.30 USDT) per batch, CRE8 keeps 10% of a 5–20% performance fee", () => {
  expect(swapFeeLabel()).toBe("0.1% per batch, at least 0.30 USDT");
  expect(performanceSplit(20)).toEqual({ total: 20, platform: 2, creator: 18 });
  expect(performanceSplit(10)).toEqual({ total: 10, platform: 1, creator: 9 });
  expect(performanceFeeLine(20)).toBe("20% of realized profit · CRE8 keeps 2%, the creator 18%");
  expect(PERFORMANCE_FEE).toEqual({ min: 5, max: 20, default: 10 });
  expect(designFeeTerms(30).performanceFeeBps).toBe(2000);
  expect(DESIGNER).not.toMatch(/Deposit fee|\+ yours|CRE8 adds/);
  expect(DESIGNER).toContain("min={PERFORMANCE_FEE.min} max={PERFORMANCE_FEE.max}");
  expect(FUND_PAGE).not.toContain("modelFees.perf + modelFees.platform");
});

// ---- M11 status 的 drift 可能是 null ----

test("M11: a status with drift null does not throw, and money already received is not reported as not sent", () => {
  expect(FUND_PAGE).toContain("const universe = fresh?.drift?.assets ?? [];");
  expect(FUND_PAGE).not.toMatch(/\b(live|fresh)\.drift\.assets/);
  expect(read("src/lib/api.ts")).toMatch(/assets: DriftAssetRow\[\];\n {2}\} \| null;/);
  expect(FUND_PAGE).toContain("if (funded && !transferHash) {");
});

// ---- L1 權重先量化到 bps，非現金至少 1 bps ----

test("L1: a 0.001% weight is caught before the strategy is created", () => {
  const usdt = "0xusdt";
  expect(zeroBpsAssets([["0xbtc", 0.001], ["0xeth", 99.999]], usdt)).toEqual(["0xbtc"]);
  expect(zeroBpsAssets([["0xbtc", 0.01], [usdt, 0.001]], usdt)).toEqual([]);
  expect(quantizePercent(0.001)).toBe(0);
  expect(quantizePercent(33.337)).toBe(33.34);
  expect(percentToBps(12.5)).toBe(1250);
  expect(CREATE_PAGE).toContain("tooSmall.length === 0");
});

// ---- L2 沒有「+ Another strategy」----

test("L2: the designer no longer offers a second strategy for the same asset", () => {
  expect(DESIGNER).not.toContain("+ Another strategy</button>");
  expect(DESIGNER).not.toContain("B.addSlice(");
});

// ---- L3 匯出套用目前的鏈與地址 ----

test("L3: Download design on chain 97 writes chain 97 and the testnet addresses", () => {
  const design = {
    chainId: 56, platformFeeBps: 1000, depositFeeBps: 100, performanceFeeBps: 1000,
    cash: { token: "USDT", shareBps: 1000 },
    assets: [{ symbol: "CAKE", token: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82" }],
  };
  const testnet = exportDesign(design, { chainId: 97, testnet: true, feePct: 15 });
  expect(testnet.chainId).toBe(97);
  expect(testnet.assets).toEqual([{ symbol: "CAKE", token: testnetToken("CAKE") }]);
  expect((testnet.cash as { address: string }).address).toBe(testnetToken("USDT")!);
  expect("depositFeeBps" in testnet || "platformFeeBps" in testnet).toBe(false);
  expect(testnet.platformShareOfPerformanceFeeBps).toBe(1000);
  const mainnet = exportDesign(design, { chainId: 56, testnet: false, feePct: 15 });
  expect(mainnet.assets).toEqual(design.assets);
  expect(DESIGNER).toContain("exportDesign(B.fundDesign(");
});

// ---- L4 登入彈窗留住焦點 ----

test("L4: Tab stays inside the sign-in dialog, and focus returns when it closes", () => {
  const items = ["google", "x", "email", "wallet", "not-now"];
  expect(trapFocus(items, "not-now", false)).toBe("google");
  expect(trapFocus(items, "google", true)).toBe("not-now");
  expect(trapFocus(items, "x", false)).toBeNull();
  expect(trapFocus(items, null, false)).toBe("google");
  const screen = read("src/components/SignInScreen.tsx");
  expect(screen).toContain("returnFocus.current = document.activeElement instanceof HTMLElement");
  expect(screen).toContain("if (target?.isConnected) target.focus();");
});

// ---- L5 名稱的 emoji ----

test("L5: display names keep emoji sequences and count what people see", () => {
  expect(cleanDisplayName("🧑‍💻")).toBe("🧑‍💻");
  expect(graphemes(cleanDisplayName("👍🏽".repeat(30)))).toHaveLength(24);
  expect(cleanDisplayName("a‍b")).toBe("ab"); // 落單的零寬連接字拿掉
  expect(initialOf("👍🏽 x")).toBe("👍🏽");
});

// ---- L6 空的 VITE_CHAIN_ID ----

test("L6: an empty VITE_CHAIN_ID falls back to the local fork, not chain 0", () => {
  expect(readChainId("")).toBe(DEFAULT_CHAIN_ID);
  expect(readChainId(undefined)).toBe(1337);
  expect(readChainId(" 97 ")).toBe(97);
  expect(readChainId("abc")).toBe(1337);
  expect(read(".env.example")).not.toMatch(/^VITE_CHAIN_ID=$/m);
});

// ---- L7 文件的登入方式 ----

test("L7: the docs list Google, X, email and wallet sign-in, not Apple", () => {
  for (const file of ["README.md", ".env.example"]) {
    // 舊文件把 Apple 列成登入方式（「email、Google、Apple、錢包」）；現在只能出現在「不用 Apple」。
    expect(read(file)).not.toMatch(/Google、Apple|Google, Apple|Apple or a wallet|Apple／/);
    expect(read(file)).toMatch(/X \(Twitter\)|Google／X|Google, X/);
  }
});

// ---- L8 兩條鏈都跑 ----

test("L8: CI runs the unit tests a second time with VITE_CHAIN_ID=97", () => {
  expect(read(".github/workflows/ci.yml")).toMatch(/Unit tests \(chain 97\)[\s\S]{0,80}VITE_CHAIN_ID: '97'/);
  expect(JSON.parse(read("package.json")).scripts["test:97"]).toBe("VITE_CHAIN_ID=97 bun test tests");
});

// ---- N1 設計規格 ----

test("N1: DESIGN.md describes per-asset settings, up to a year of buys and the open rebalance options", () => {
  const design = read("DESIGN.md");
  expect(design).not.toContain("一檔基金一種，Buy & hold 或 Stack，全部資產共用");
  expect(design).toContain("**每個資產各自**選 Buy & hold 或 Stack");
  expect(design).toContain("每天 2–365 期、每週 2–52 期");
  expect(design).toContain("偏離目標超過 5 點");
});
