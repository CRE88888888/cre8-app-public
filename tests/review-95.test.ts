import { expect, test } from "bun:test";
import fs from "node:fs";
import type { Address } from "viem";
import { AddressBookMismatchError, addressBookMismatch, assertAddressBook } from "../src/lib/address-book-check";
import { LEGACY_REGISTRY_ABI, REGISTRY_ABI, readOnchainAccount } from "../src/lib/atp-contracts";
import { parsePreview, previewBuys, previewScheduler, type PreviewState } from "../src/lib/contribution-preview";
import { effectiveVersion, opensAtFrom } from "../src/lib/fund-versions";
import { ShownVersionChangedError, assertShownVersion } from "../src/lib/first-enroll";
import { TESTNET_97 } from "../src/lib/testnet-97";

// #95 部署前審查（rv-app95）第 1、3、4、7、8、9、12 項。第 2、5 項在 p11-versions／first-enroll，第 6 項在 yield，
// 第 10 項在 contribution-preview，第 11 項在 p11-versions 的建立頁測試。

const BOOK = { chainId: 97, registry: TESTNET_97.contracts.registry, executor: TESTNET_97.contracts.executor };
const status = (body: Record<string, unknown>) => JSON.stringify({ globalPaused: false, maxBuyBps: 100, checkedAt: "2026-11-16T00:00:00Z", block: "1", ...body });

test("1. the address book must match the backend's chain, registry and executor before anything is signed", async () => {
  const same = status({ chainId: 97, registry: BOOK.registry.toLowerCase(), executor: BOOK.executor.toUpperCase().replace("0X", "0x") });
  expect(addressBookMismatch(200, same, BOOK)).toBeNull();
  expect(addressBookMismatch(200, status({ chainId: 97, registry: "0x0000000000000000000000000000000000000001", executor: BOOK.executor }), BOOK)).toBe("registry differs");
  expect(addressBookMismatch(200, status({ chainId: 97, registry: BOOK.registry, executor: "0x0000000000000000000000000000000000000002" }), BOOK)).toBe("executor differs");
  expect(addressBookMismatch(200, status({ chainId: 56, registry: BOOK.registry, executor: BOOK.executor }), BOOK)).toBe("different network");
  // 讀不到（503、預覽站的 PREVIEW_ONLY、HTML、欄位是 null）一律不算對得上。
  expect(addressBookMismatch(503, same, BOOK)).toBe("platform status unavailable");
  expect(addressBookMismatch(200, "<html>", BOOK)).toBe("platform status unreadable");
  expect(addressBookMismatch(200, status({ chainId: 97, registry: null, executor: BOOK.executor }), BOOK)).toBe("registry differs");
  await expect(assertAddressBook(BOOK, async () => ({ status: 200, text: same }))).resolves.toBeUndefined();
  await expect(assertAddressBook(BOOK, async () => ({ status: 503, text: "" }))).rejects.toBeInstanceOf(AddressBookMismatchError);
  await expect(assertAddressBook(BOOK, async () => { throw new Error("offline"); })).rejects.toBeInstanceOf(AddressBookMismatchError);
  // chain 56 沒有內建地址簿：不檢查、不打請求。
  let reads = 0;
  await assertAddressBook(null, async () => { reads += 1; return { status: 503, text: "" }; });
  expect(reads).toBe(0);
  // 每一筆 sudo UserOp（含續期）在建帳戶物件、簽名之前先核對。
  const kernel = fs.readFileSync("src/lib/kernel.ts", "utf8");
  const check = kernel.indexOf("await assertAddressBook(CHAIN.contracts === null ? null : { chainId: CHAIN.id, registry: CHAIN.contracts.registry, executor: CHAIN.contracts.executor }, getPlatformStatusText);");
  expect(check).toBeGreaterThan(kernel.indexOf("export async function sendSudoCalls("));
  expect(check).toBeLessThan(kernel.indexOf("const sudoAccount = await createKernelAccount("));
});

test("3. chain 56 decodes the old four-field Version; chain 97 the P11 seven-field one", async () => {
  const fields = (abi: readonly unknown[]) => ((abi.find((item) => (item as { name?: string }).name === "version") as { outputs: { components: unknown[] }[] }).outputs[0]!.components.length);
  expect(fields(LEGACY_REGISTRY_ABI)).toBe(4);
  expect(fields(REGISTRY_ABI)).toBe(7);
  const used: number[] = [];
  const client = {
    readContract: async ({ functionName, abi }: { functionName: string; abi: readonly unknown[] }) => {
      switch (functionName) {
        case "registry": return "0x737b585594DD24F9D5d154Abd1B742CFBE6927C5";
        case "enrollments": return { strategyId: 3n, version: 1, paused: false };
        case "pauseFlags": return 0;
        case "activeVersion": return 2;
        case "version": used.push(fields(abi)); return { assets: ["0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"], weightsBps: [10_000], scheduleHash: `0x${"0".repeat(64)}`, activeAt: 1n };
        default: throw new Error(functionName);
      }
    },
  } as never;
  const EXECUTOR = "0x8fa4b65a2f5b9f6159cb9efe3018873712f985d7" as Address;
  const ACCOUNT = "0x8ac8258516d8f4298b1d7629867dd22121e672ed" as Address;
  expect((await readOnchainAccount(client, EXECUTOR, ACCOUNT, false)).latestVersion).toBe(2);
  expect(used).toEqual([4, 4]);
  used.length = 0;
  await readOnchainAccount(client, EXECUTOR, ACCOUNT, true);
  expect(used).toEqual([7, 7]);
});

test("4. preview, allocation and signing use the version in effect, not versions[0]", () => {
  const NOW = Date.parse("2026-11-16T12:00:00Z");
  // 後端倒序：v2 還沒生效、v1 生效中。
  const versions = [
    { version: 2, activeAt: "2026-11-17T12:01:00Z", pending: true },
    { version: 1, activeAt: "2026-11-15T12:00:00Z" },
  ];
  expect(effectiveVersion(versions, undefined, NOW)?.version).toBe(1);
  // 沒有 pending 旗標，也看 activeAt。
  expect(effectiveVersion([{ version: 2, activeAt: "2026-11-17T12:01:00Z" }, { version: 1, activeAt: null }], undefined, NOW)?.version).toBe(1);
  // 鏈上 activeVersion 讀得到時以它為準；鏈上說沒有生效版就是沒有。
  expect(effectiveVersion(versions, 2, NOW)?.version).toBe(2);
  expect(effectiveVersion(versions, null, NOW)).toBeUndefined();
  expect(effectiveVersion(versions, 9, NOW)).toBeUndefined();
  expect(effectiveVersion([{ version: 1, activeAt: "2026-11-17T00:00:00Z" }], undefined, NOW)).toBeUndefined();
  expect(effectiveVersion(undefined)).toBeUndefined();
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("const effective = effectiveVersion(communityStrategy.data?.versions, versionSchedule.data === undefined ? undefined : (versionSchedule.data.active?.version ?? null));");
  expect(page).not.toContain("versions[0]?.execution");
  // 概覽（合成 fund 的配置）與持倉表也用同一份 `effective`（含鏈上版本），不再自己用裝置時間算（#95 最後複審第 1 項）。
  expect(page.match(/effectiveVersion\(/g)?.length).toBe(1);
  expect(page.match(/const version = effective \?\? detail\.versions\[0\];/g)?.length).toBe(2);
  expect(page.indexOf("const communityFund = useMemo(")).toBeGreaterThan(page.indexOf("const effective = effectiveVersion("));
  expect(page).toContain("}, [communityStrategy.data, effective]);");
  // 簽名用的是後端接受的版本與 configHash（first-enroll 已核對它和鏈上一致）。
  expect(page).toContain("expectedVersion: prepared.expectedVersion,");
  expect(page).toContain("configHash: prepared.configHash,");
});

test("4. before signing, the version the buyer confirmed on screen must be the one the backend will sign", () => {
  const prepared = { expectedVersion: 2, configHash: `0x${"ab".repeat(32)}` as `0x${string}` };
  expect(() => assertShownVersion({ version: 2, configHash: `0x${"AB".repeat(32)}` }, prepared)).not.toThrow();
  // 跨過生效時間：畫面還是 v1，後端與鏈上已是 v2；或同號但 configHash 不同；或畫面還沒讀到版本。
  for (const shown of [{ version: 1, configHash: prepared.configHash }, { version: 2, configHash: `0x${"cd".repeat(32)}` }, { version: 2 }, null]) {
    expect(() => assertShownVersion(shown, prepared)).toThrow(ShownVersionChangedError);
  }
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  const check = page.indexOf("assertShownVersion(shownVersion, prepared);");
  expect(check).toBeGreaterThan(page.indexOf("const prepared = await waitForPreparation("));
  // 比對在簽名之前；不同就刷新畫面上的版本與策略內容後中止。
  expect(check).toBeLessThan(page.indexOf("const joinCalls = await firstEnrollCalls("));
  expect(check).toBeLessThan(page.indexOf("const joined = await sendSudoCalls("));
  expect(page.indexOf("await Promise.all([versionSchedule.refetch(), communityStrategy.refetch()]);")).toBeGreaterThan(check);
  expect(page).toContain("const shownVersion = versionSchedule.data?.active ?? null;");
  expect(page).toContain("Version {shownVersion.version} in effect.");
});

test("7. a preview that does not match the request falls back to the estimate (about)", async () => {
  const NOW = Date.parse("2026-11-16T12:00:00.000Z");
  const raw = (usdt: number) => (BigInt(usdt) * 10n ** 18n).toString();
  const request = {
    chainId: 97,
    amountRaw: raw(1_000),
    execution: {
      kind: "per_asset", numeraire: "0xusdt", rebalance: "none",
      assets: [
        { asset: "0xusdt", weightBps: 1_000, yield: null },
        { asset: "0xbtc", weightBps: 9_000, execution: { kind: "stack", every: "weekly", weekday: 1, timeUtc: "01:00", slices: 12 }, yield: null },
      ],
    },
  };
  const good = { minimumRaw: raw(50), effectiveSlices: { "0xBTC": 12 }, slots: [{ at: "2026-11-17T01:00:00.000Z", budgetRaw: raw(75) }, { at: "2026-11-24T01:00:00.000Z", budgetRaw: raw(75) }] };
  expect(parsePreview(good, request, NOW)).not.toBeNull();
  for (const bad of [
    { ...good, minimumRaw: "0" },
    // 第二輪：最低投入不能低於前端公式（這檔 90% 非現金 → 50 USDT）。
    { ...good, minimumRaw: "1" },
    { ...good, minimumRaw: (BigInt(raw(50)) - 1n).toString() },
    { ...good, effectiveSlices: { "0xbtc": 999_999 } },
    { ...good, effectiveSlices: { "0xbtc": 13 } },
    { ...good, effectiveSlices: { "0xeth": 3 } },
    { ...good, slots: [{ at: "not a date", budgetRaw: raw(75) }] },
    // 第二輪：時間在現在之前（1970）、沒有一期比一期晚、預算是 0。
    { ...good, slots: [{ at: "1970-01-01T00:00:00.000Z", budgetRaw: raw(75) }] },
    { ...good, slots: [good.slots[1], good.slots[0]] },
    { ...good, slots: [good.slots[0], good.slots[0]] },
    { ...good, slots: [{ ...good.slots[0], budgetRaw: "0" }] },
  ]) expect(parsePreview(bad, request, NOW)).toBeNull();
  // 時鐘誤差 5 分鐘以內仍接受。
  expect(parsePreview({ ...good, slots: [{ at: "2026-11-16T11:56:00.000Z", budgetRaw: raw(75) }] }, request, NOW)).not.toBeNull();
  const states: PreviewState[] = [];
  const timers = { set: (run: () => void) => { run(); return 1; }, clear: () => {} };
  previewScheduler((state) => states.push(state), { send: async () => ({ ...good, minimumRaw: "1" }), timers, now: () => NOW }).request(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(states.at(-1)).toEqual({ status: "fallback", code: "BAD_RESPONSE" });
});

test("13. a real backend preview for a Hold + Stack fund is accepted: Hold assets come back as 1", async () => {
  // backend asset-plan.ts previewFundingContribution 的輸出形狀：effectiveSlices 列出全部非現金資產（Hold＝1），
  // slots 依時間排序、取前三期與最後一期，時間是 ISO，預算是 18 位整數字串。
  const NOW = Date.parse("2026-11-16T12:00:00.000Z");
  const execution = {
    kind: "per_asset", numeraire: "0x7ad6e310b0f6744b66d97cb7cb525bd974501cb5", rebalance: "none",
    assets: [
      { asset: "0x7ad6e310b0f6744b66d97cb7cb525bd974501cb5", weightBps: 0, yield: null },
      { asset: "0x2bacaad9ebc8a2827689f7abbffcbfcbe63c70c1", weightBps: 4_000, execution: { kind: "stack", every: "daily", weekday: null, timeUtc: "01:00", slices: 80 }, yield: null },
      { asset: "0x6a42bf6ad662aa00de6d00a3da448f4b20b95f3b", weightBps: 4_000, execution: { kind: "stack", every: "daily", weekday: null, timeUtc: "01:00", slices: 80 }, yield: null },
      { asset: "0x3f2905ce60d4f01e62d7feefa4aff977bc377c90", weightBps: 2_000, execution: { kind: "hold" }, yield: null },
    ],
  };
  const request = { chainId: 97, execution, amountRaw: "10000000000000000000000" };
  const backend = {
    minimumRaw: "50000000000000000000",
    effectiveSlices: {
      "0x2bacaad9ebc8a2827689f7abbffcbfcbe63c70c1": 80,
      "0x6a42bf6ad662aa00de6d00a3da448f4b20b95f3b": 80,
      "0x3f2905ce60d4f01e62d7feefa4aff977bc377c90": 1,
    },
    slots: [
      { at: "2026-11-16T12:01:00.000Z", budgetRaw: "2000000000000000000000" },
      { at: "2026-11-17T01:00:00.000Z", budgetRaw: "100000000000000000000" },
      { at: "2026-11-18T01:00:00.000Z", budgetRaw: "100000000000000000000" },
      { at: "2027-02-04T01:00:00.000Z", budgetRaw: "100000000000000000000" },
    ],
  };
  const parsed = parsePreview(backend, request, NOW);
  expect(parsed?.effectiveSlices).toEqual(backend.effectiveSlices);
  // 前端用後端的 80 期（不是退回估計的 30／50 期），而且不標 about。
  const buys = previewBuys(execution, 10_000, { status: "ok", amountRaw: request.amountRaw, preview: parsed! });
  expect(buys.map((buy) => [buy.buys, buy.about])).toEqual([[80, false], [80, false]]);
  // Hold 只能是 1。
  expect(parsePreview({ ...backend, effectiveSlices: { ...backend.effectiveSlices, "0x3f2905ce60d4f01e62d7feefa4aff977bc377c90": 2 } }, request, NOW)).toBeNull();
  // 現金不在清單上。
  expect(parsePreview({ ...backend, effectiveSlices: { ...backend.effectiveSlices, "0x7ad6e310b0f6744b66d97cb7cb525bd974501cb5": 1 } }, request, NOW)).toBeNull();
});

test("8. performance fee is paused: the buy ticket and Fund facts show no performance fee (cre8-app#123)", () => {
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  // 2026-11-19 產品說明 §9#1：借款、第三批、績效費第一階段暫停，畫面收起來。合約與 ABI 不動。
  expect(page).not.toMatch(/Performance fee|performance fee|% of profit|% of realized profit|performanceFeeLine/);
  // 下單面板只留生效中的版本。
  expect(page).toContain('data-entry="version-in-effect"');
  expect(page).toContain("Version {shownVersion.version} in effect.");
});

test("9. a P11 portfolio on an older version: new buys paused until it can move, sell and take out stay open", () => {
  const controls = fs.readFileSync("src/features/fund/AccountControls.tsx", "utf8");
  const p11 = controls.indexOf("{P11_REGISTRY ? (");
  const legacy = controls.indexOf("Your account stays on version {state.version} until you");
  expect(p11).toBeGreaterThan(-1);
  expect(legacy).toBeGreaterThan(p11);
  // 第二輪：明講新版已生效、這個投組暫停買入（轉版一週內開放）、可以隨時賣出或原樣轉出。
  expect(controls).toContain("Version {upgradeTo} is now in effect. This portfolio was set up on version {state.version}, so new");
  expect(controls).toContain("buys into it are paused until portfolios can move to the new version (opening within a week). You");
  expect(controls).toContain("can still sell, or take your assets out as they are, at any time.");
  // 不承諾重新授權會恢復買入：P11 不顯示更新按鈕與它的說明。
  expect(controls).not.toContain("approves any\n                      new assets, so they can be bought for you");
  const hidden = controls.indexOf("{!P11_REGISTRY && (");
  expect(hidden).toBeGreaterThan(p11);
  expect(controls.indexOf("void send('upgrade')")).toBeGreaterThan(hidden);
  // 加入時的版本與目前生效版分開寫，舊配置不標 Now。
  expect(controls).toContain("`You joined on v${state.version} · v${upgradeTo} is in effect`");
  expect(controls).toContain("{P11_REGISTRY ? `When you joined (v${state.version})` : `Now (v${state.version})`}");
  expect(controls).toContain("{P11_REGISTRY ? `In effect (v${upgradeTo})` : `New (v${upgradeTo})`}");
  expect(controls).toContain("'assets when you joined'");
});

test("12. the opening time comes from the published version's activeAt", () => {
  expect(opensAtFrom("2026-11-17T12:01:00.000Z")).toBe(Date.parse("2026-11-17T12:01:00.000Z") / 1000);
  for (const bad of [undefined, null, "", "tomorrow", 1_800_000_000]) expect(opensAtFrom(bad)).toBeUndefined();
});
