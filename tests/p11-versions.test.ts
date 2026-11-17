import { expect, test } from "bun:test";
import { decodeFunctionData, keccak256, toBytes, toFunctionSelector, type Address } from "viem";
import {
  FOLLOW_VERSIONS_PLAIN,
  FOLLOW_VERSIONS_TERMS_HASH,
  FOLLOW_VERSIONS_TERMS_TEXT,
  REGISTRY_ABI,
  enrollCalldata,
  forbiddenSessionGrants,
  readVersionSchedule,
} from "../src/lib/atp-contracts";
import { assetPlays, changeLine, feeOnlyDecrease, nextPublishAt, sellOnlyAssets, versionChanges, type OnchainVersion } from "../src/lib/fund-versions";

// cre8-contracts#54（P11，PR head de69a89）：registry 介面與版本通知期。

const ACCOUNT = "0x8ac8258516d8f4298b1d7629867dd22121e672ed" as Address;
const REGISTRY = "0x7D39178401923140dF8b5A559a02682326F17350" as Address;
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const BTC = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
const SOL = "0x570a5d26f7765ecb712c0924e4de545b89fd43df";
const ZERO = `0x${"0".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

test("ABI selectors match the P11 registry", () => {
  const selectors = (name: string) => REGISTRY_ABI.filter((item) => item.type === "function" && item.name === name);
  expect(enrollCalldata(ACCOUNT, 9n, 4, true).slice(0, 10)).toBe(toFunctionSelector("enroll(address,uint256,uint16)"));
  // 二參數 enroll 已移除：ABI 裡只有一個 enroll，而且是三參數。
  expect(selectors("enroll").length).toBe(1);
  expect((selectors("enroll")[0] as { inputs: unknown[] }).inputs.length).toBe(3);
  for (const signature of ["approveEnrollment(uint256,uint16)", "cancelVersion(uint256)", "pendingVersion(uint256)", "activeVersion(uint256)", "lastPublishedAt(uint256)", "historicalAssets(uint256)", "wasAssetAllowed(uint256,address)", "revokeEnrollmentApproval()"]) {
    const name = signature.slice(0, signature.indexOf("("));
    const item = selectors(name)[0] as { inputs: { type: string }[] } | undefined;
    expect(item).toBeDefined();
    expect(toFunctionSelector(`${name}(${item!.inputs.map((input) => input.type).join(",")})`)).toBe(toFunctionSelector(signature));
  }
  // Version tuple：原四欄之後追加 settingsHash、performanceFeeBps、configHash。
  const version = selectors("version")[0] as { outputs: { components: { name: string; type: string }[] }[] };
  expect(version.outputs[0]!.components.map((c) => `${c.type} ${c.name}`)).toEqual([
    "address[] assets", "uint16[] weightsBps", "bytes32 scheduleHash", "uint64 activeAt", "bytes32 settingsHash", "uint16 performanceFeeBps", "bytes32 configHash",
  ]);
});

test("the consent text is the contract's FOLLOW_VERSIONS_TERMS, word for word, with the plain-language version", () => {
  expect(keccak256(toBytes(FOLLOW_VERSIONS_TERMS_TEXT))).toBe(FOLLOW_VERSIONS_TERMS_HASH);
  expect(FOLLOW_VERSIONS_TERMS_HASH).toBe("0x6a09d1b304dde687ed21179a03e0d452399a5027a2a5c6bf1d95e545cffa776e");
  expect(FOLLOW_VERSIONS_PLAIN.follow).toContain("follows the new version automatically");
  expect(FOLLOW_VERSIONS_PLAIN.follow).toContain("at least 24 hours before");
  expect(FOLLOW_VERSIONS_PLAIN.follow).toContain("exit");
  expect(FOLLOW_VERSIONS_PLAIN.feeCut).toBe("Only a lower performance fee can take effect right away.");
});

test("a session key permission that includes enroll or approveEnrollment is refused before signing", () => {
  const executeRebalance = toFunctionSelector("executeRebalance(address,uint256,bytes)").slice(2);
  const clean = [`0x1234${executeRebalance}abcd`];
  expect(forbiddenSessionGrants(clean)).toEqual([]);
  expect(forbiddenSessionGrants([`0x00${toFunctionSelector("approveEnrollment(uint256,uint16)").slice(2)}00`])).toEqual(["approveEnrollment"]);
  expect(forbiddenSessionGrants([...clean, `0x${toFunctionSelector("enroll(address,uint256,uint16)").slice(2).toUpperCase()}`])).toEqual(["enroll"]);
  expect(forbiddenSessionGrants([`0x${toFunctionSelector("enroll(address,uint256)").slice(2)}`])).toEqual(["enroll"]);
  const page = require("node:fs").readFileSync("src/features/fund/FundPage.tsx", "utf8") as string;
  const guard = page.indexOf("const forbidden = forbiddenSessionGrants(params.initConfig);");
  expect(guard).toBeGreaterThan(-1);
  // 檢查在送出續期 UserOp 之前。
  expect(guard).toBeLessThan(page.indexOf("const receipt = await sendRenewalUserOp({"));
});

const v = (version: number, assets: [string, number][], fee = 1_000, settingsHash = ZERO, activeAt = 1_800_000_000): OnchainVersion => ({
  version, activeAt, settingsHash, performanceFeeBps: fee, assets: assets.map(([asset, weightBps]) => ({ asset, weightBps })),
});

test("change summary: assets, weights, strategy per asset, performance fee", () => {
  const active = v(1, [[USDT, 1_000], [BTC, 6_000], [ETH, 3_000]]);
  const next = v(2, [[USDT, 1_000], [BTC, 5_000], [SOL, 4_000]], 1_500, HASH_B);
  const plays = {
    active: { [BTC]: "Buy & hold", [ETH]: "Buy & hold" },
    next: { [BTC]: "Stack, weekly over 12 buys", [SOL]: "Buy & hold" },
  };
  const changes = versionChanges(active, next, plays);
  expect(changes).toEqual([
    { kind: "weight", asset: BTC, from: 6_000, to: 5_000 },
    { kind: "added", asset: SOL, weightBps: 4_000 },
    { kind: "removed", asset: ETH, weightBps: 3_000 },
    { kind: "play", asset: BTC, from: "Buy & hold", to: "Stack, weekly over 12 buys" },
    { kind: "fee", from: 1_000, to: 1_500 },
  ]);
  const symbol = (asset: string) => ({ [BTC]: "BTCB", [ETH]: "ETH", [SOL]: "SOL" })[asset] ?? "?";
  expect(changes.map((change) => changeLine(change, symbol))).toEqual([
    "BTCB: 60% → 50%",
    "Adds SOL at 40%",
    "Removes ETH (was 30%). You can still sell what you hold; it is no longer bought.",
    "BTCB: Buy & hold → Stack, weekly over 12 buys",
    "Performance fee: 10% → 15%",
  ]);
  // 拿不到逐資產設定：只說買法有變。
  expect(versionChanges(active, v(2, [[USDT, 1_000], [BTC, 6_000], [ETH, 3_000]], 1_000, HASH_B))).toEqual([{ kind: "settings" }]);
});

test("only a strictly lower fee with everything else identical counts as an immediate change", () => {
  const active = v(1, [[USDT, 1_000], [BTC, 9_000]], 1_500);
  expect(feeOnlyDecrease(active, v(2, [[USDT, 1_000], [BTC, 9_000]], 1_000))).toBe(true);
  expect(feeOnlyDecrease(active, v(2, [[USDT, 1_000], [BTC, 9_000]], 1_500))).toBe(false);
  expect(feeOnlyDecrease(active, v(2, [[USDT, 1_000], [BTC, 9_000]], 2_000))).toBe(false);
  expect(feeOnlyDecrease(active, v(2, [[USDT, 2_000], [BTC, 8_000]], 1_000))).toBe(false);
  expect(feeOnlyDecrease(active, v(2, [[BTC, 9_000], [USDT, 1_000]], 1_000))).toBe(false);
  expect(feeOnlyDecrease(active, v(2, [[USDT, 1_000], [BTC, 9_000]], 1_000, HASH_B))).toBe(false);
});

test("assets dropped by the current version can be sold but not bought", () => {
  expect(sellOnlyAssets([USDT, BTC, ETH, ETH.toUpperCase()], [{ asset: USDT }, { asset: BTC.toUpperCase() }])).toEqual([ETH]);
  expect(sellOnlyAssets([USDT, BTC], [{ asset: USDT }, { asset: BTC }])).toEqual([]);
});

test("publishing again waits 7 days from the last publish", () => {
  expect(nextPublishAt(0)).toBe(0);
  expect(nextPublishAt(1_800_000_000)).toBe(1_800_000_000 + 7 * 86_400);
});

test("per-asset plays come from the backend execution", () => {
  expect(assetPlays({ kind: "per_asset", assets: [
    { asset: USDT, weightBps: 1_000, yield: null },
    { asset: BTC.toUpperCase(), weightBps: 9_000, execution: { kind: "stack", every: "weekly", weekday: 1, timeUtc: "01:00", slices: 12 }, yield: null },
  ] })).toEqual({ [BTC]: "Stack, weekly over 12 buys" });
  expect(assetPlays({ kind: "target_weight" })).toBeNull();
});

test("the schedule reader reads active, pending, last publish and historical assets", async () => {
  const versions: Record<number, unknown> = {
    1: { assets: [USDT, BTC], weightsBps: [1_000, 9_000], scheduleHash: ZERO, activeAt: 100n, settingsHash: ZERO, performanceFeeBps: 1_000, configHash: ZERO },
    2: { assets: [USDT, SOL], weightsBps: [2_000, 8_000], scheduleHash: ZERO, activeAt: 2_000_000_000n, settingsHash: HASH_B, performanceFeeBps: 1_000, configHash: ZERO },
  };
  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      switch (functionName) {
        case "activeVersion": return 1;
        case "pendingVersion": return 2;
        case "lastPublishedAt": return 1_999_913_600n;
        case "historicalAssets": return [USDT, BTC, ETH];
        case "version": return versions[args[1] as number];
        default: throw new Error(functionName);
      }
    },
  };
  const schedule = await readVersionSchedule(client as never, REGISTRY, 5n);
  expect(schedule.active).toEqual({ version: 1, activeAt: 100, settingsHash: ZERO, configHash: ZERO, performanceFeeBps: 1_000, assets: [{ asset: USDT, weightBps: 1_000 }, { asset: BTC, weightBps: 9_000 }] });
  expect(schedule.pending?.version).toBe(2);
  expect(schedule.pending?.activeAt).toBe(2_000_000_000);
  expect(schedule.lastPublishedAt).toBe(1_999_913_600);
  expect(schedule.historicalAssets).toEqual([USDT, BTC, ETH]);
});

import { erc20Abi, maxUint256 } from "viem";
import { EnrollVersionChangedError, FundNotOpenError, firstEnrollCalls } from "../src/lib/atp-contracts";

const EXECUTOR = "0xE3725CBdC1B4BE58ed9b49E6f863cDDE654bbfce" as Address;
const CONFIG = `0x${"cd".repeat(32)}` as const;
const TEST_USDT = "0x7Ad6E310B0F6744B66d97Cb7cb525BD974501cb5" as Address;
function registryClient(state: { enrolledId?: bigint; enrolledVersion?: number; active?: number; assets?: string[]; configHash?: string }) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "enrollments": return { strategyId: state.enrolledId ?? 0n, version: state.enrolledVersion ?? 0, paused: false };
        case "activeVersion": return state.active ?? 3;
        case "version": return { assets: state.assets ?? [USDT, BTC, BTC.toUpperCase()], weightsBps: [], scheduleHash: ZERO, activeAt: 1n, settingsHash: ZERO, performanceFeeBps: 1_000, configHash: state.configHash ?? CONFIG };
        default: throw new Error(functionName);
      }
    },
  } as never;
}

const join = (client: never, expectedVersion = 3, configHash: `0x${string}` = CONFIG) =>
  firstEnrollCalls(client, { registry: REGISTRY, executor: EXECUTOR, usdt: TEST_USDT, account: ACCOUNT, id: 5n, expectedVersion, configHash });

test("first buy: one owner-signed UserOp with only enroll at the accepted version and the USDT approval", async () => {
  // 審查 #95 第 2 項：後端代付只收 enroll＋一筆 USDT approve；其他資產（就算有 40 個）在建好投組後分批授權。
  const many = Array.from({ length: 40 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`);
  for (const assets of [undefined, many]) {
    const calls = await join(registryClient({ assets }));
    expect(calls).toHaveLength(2);
    expect(calls![0]).toEqual({ to: REGISTRY, data: enrollCalldata(ACCOUNT, 5n, 3, true), value: 0n });
    expect(calls![1]!.to).toBe(TEST_USDT);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls![1]!.data }).args).toEqual([EXECUTOR, maxUint256]);
    expect(calls!.some((call) => call.data.startsWith(toFunctionSelector("approveEnrollment(uint256,uint16)")))).toBe(false);
  }
});

test("before signing, the chain must still be on the version the backend accepted, with the same config hash", async () => {
  // 審查 #95 第 5 項。
  await expect(join(registryClient({ active: 4 }), 3)).rejects.toBeInstanceOf(EnrollVersionChangedError);
  await expect(join(registryClient({ configHash: `0x${"ee".repeat(32)}` }))).rejects.toBeInstanceOf(EnrollVersionChangedError);
  expect(await join(registryClient({}), 3, CONFIG.toUpperCase().replace("0X", "0x") as `0x${string}`)).toHaveLength(2);
});

test("already joined at the active version: skip; joined at an older version or not at all: enroll", async () => {
  expect(await join(registryClient({ enrolledId: 5n, enrolledVersion: 3 }))).toBeNull();
  expect(await join(registryClient({ enrolledId: 5n, enrolledVersion: 2 }))).not.toBeNull();
  // 第一版還沒生效（也要等 24 小時）：不能加入。
  await expect(join(registryClient({ active: 0 }))).rejects.toBeInstanceOf(FundNotOpenError);
});

test("first buy on chain 97: backend deploys the account, the owner signs enroll+approve, then the backend confirms", () => {
  const fs = require("node:fs");
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8") as string;
  const prepare = page.indexOf("const prepared = await waitForPreparation(() => prepareEnrollment(token, strategy.id));");
  const code = page.indexOf("await waitForAccountCode((address) => readOnlyClient().getCode({ address }), prepared.account);");
  const join = page.indexOf("const joinCalls = await firstEnrollCalls(");
  const sign = page.indexOf("const joined = await sendSudoCalls({ wallet, token, accountAddress: prepared.account, strategyId: strategy.id, calls: joinCalls });");
  const confirm = page.indexOf("const created = await confirmEnrollment(token, strategy.id);");
  for (const index of [prepare, code, join, sign, confirm]) expect(index).toBeGreaterThan(-1);
  // 順序：後端部署 → 鏈上看得到帳戶 → 組 enroll＋approve → 本人簽 → 後端確認 → 才拿測試 USDT／轉帳。
  expect(prepare).toBeLessThan(code);
  expect(code).toBeLessThan(join);
  expect(join).toBeLessThan(sign);
  expect(sign).toBeLessThan(confirm);
  expect(confirm).toBeLessThan(page.indexOf("funding = await retryWhileBusy(() => postBuyFunding(token, target), busyRetry);"));
  expect(page).not.toContain("approveEnrollment");
  // 只有還沒有帳戶時才加入；已持有的人不會每次買都被要求重簽。
  expect(page.lastIndexOf("if (account === undefined) {", join)).toBeGreaterThan(page.indexOf("let account = holding?.smartAccounts[0]?.address;"));
  expect(page.match(/firstEnrollCalls\(/g)?.length).toBe(1);
  // 白話條款只在第一次買（還沒持有）而且是 P11 鏈時顯示。
  expect(page).toContain("{holding === undefined && CHAIN.contracts?.registry !== undefined && <FollowVersionsTerms terms={FOLLOW_VERSIONS_TERMS_TEXT} />}");
  expect(page).toContain("if (holding === undefined && versionSchedule.data !== undefined && versionSchedule.data.active === null) throw new FundNotOpenError();");
});

test("a sudo UserOp is never built for an account that is not deployed yet (no initCode)", () => {
  const fs = require("node:fs");
  const kernel = fs.readFileSync("src/lib/kernel.ts", "utf8") as string;
  const start = kernel.indexOf("export async function sendSudoCalls(");
  const guard = kernel.indexOf("if (code === undefined || code === '0x') throw new AccountNotDeployedError(args.accountAddress);", start);
  expect(guard).toBeGreaterThan(start);
  expect(guard).toBeLessThan(kernel.indexOf("const sudoAccount = await createKernelAccount(", start));
});

test("who may cancel comes from the backend (canCancel), not from comparing the connected wallet", () => {
  const fs = require("node:fs");
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8") as string;
  expect(page).toContain("const canCancelVersion = ownStrategy.data?.versions.some((version) => version.canCancel === true) === true;");
  expect(page).toContain("creator={canCancelVersion ? { onCancel: () => void cancelVersion(), cancelling: cancellingVersion } : null}");
  expect(page).not.toMatch(/strategy\.provider\.toLowerCase\(\) === connectedAddress/);
  const api = fs.readFileSync("src/lib/api.ts", "utf8") as string;
  expect(api).toContain("request(`/strategies/${strategyId}/versions/cancel`, { method: 'POST', token, body: {} })");
});

test("creating a fund on the P11 chain stops after publishing and explains the 24-hour wait", () => {
  const fs = require("node:fs");
  const create = fs.readFileSync("src/features/create/CreateFundPage.tsx", "utf8") as string;
  expect(create).toContain("const VERSION_NOTICE_CHAIN = CHAIN.contracts?.registry !== undefined;");
  const stop = create.indexOf("if (VERSION_NOTICE_CHAIN) {");
  expect(stop).toBeGreaterThan(create.indexOf("const published = await publishVersion(token, strategy.id, version);"));
  expect(stop).toBeLessThan(create.indexOf("const portfolio = await enrollPortfolio(token, strategy.id);"));
  for (const rule of ["PUBLISH_RULES.delay", "PUBLISH_RULES.interval", "PUBLISH_RULES.feeCut"]) expect(create).toContain(`{${rule}}`);
  // 審查 #95 第 11 項：首發版本不能取消（backend#126 canCancel=false），建立頁不寫取消的承諾。
  expect(create).not.toContain("{PUBLISH_RULES.cancel}");
  expect(create).not.toMatch(/you can cancel it/i);
  // 審查 #95 第 12 項：開放時間用發版回應的 activeAt，不自己算 +24h。
  expect(create).toContain("opensAt: opensAtFrom(published.activeAt)");
  expect(create).not.toContain("Date.now() / 1000) + VERSION_DELAY_SECONDS");
  expect(create).toContain("`Your fund opens for buying on ${whenText(created.opensAt)}.`");
});

test("chain 56 reads no version schedule", () => {
  const fs = require("node:fs");
  const hook = fs.readFileSync("src/features/fund/use-version-schedule.ts", "utf8") as string;
  expect(hook).toContain("const registry = CHAIN.contracts?.registry ?? null;");
  expect(hook).toContain("enabled: registry !== null &&");
});
