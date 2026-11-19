import { expect, test } from "bun:test";
import fs from "node:fs";
import { sendUserOp, usesEarlyHash } from "../src/lib/userop-send";

// 總管 2026-11-16：廣播前先算 hash 的新路徑只給生息（帶 onSubmitted）而且是 chain 97；
// 其他呼叫者（建立基金、批次授權、AccountControls）與 chain 56 維持原本的 viem sendUserOperation。

const H = `0x${"a".repeat(64)}` as const;

function mocks() {
  const calls: string[] = [];
  return {
    calls,
    legacy: async () => { calls.push("legacy"); return H; },
    early: async (onSubmitted: (hash: `0x${string}`) => void) => { calls.push("early"); onSubmitted(H); return H; },
  };
}

test("without onSubmitted the old sendUserOperation path is used, on every chain", async () => {
  for (const chainId of [56, 97, 31337]) {
    const m = mocks();
    expect(await sendUserOp({ chainId, legacy: m.legacy, early: m.early })).toBe(H);
    expect(m.calls).toEqual(["legacy"]);
    expect(usesEarlyHash(chainId, undefined)).toBe(false);
  }
});

test("chain 56 always uses the old path, even with onSubmitted (then told the hash after sending)", async () => {
  const m = mocks();
  const seen: string[] = [];
  await sendUserOp({ chainId: 56, onSubmitted: (hash) => seen.push(hash), legacy: m.legacy, early: m.early });
  expect(m.calls).toEqual(["legacy"]);
  expect(seen).toEqual([H]);
  expect(usesEarlyHash(56, () => undefined)).toBe(false);
});

test("only lending on chain 97 (onSubmitted given) takes the early-hash path", async () => {
  const m = mocks();
  const seen: string[] = [];
  await sendUserOp({ chainId: 97, onSubmitted: (hash) => seen.push(hash), legacy: m.legacy, early: m.early });
  expect(m.calls).toEqual(["early"]);
  expect(seen).toEqual([H]);
  expect(usesEarlyHash(97, () => undefined)).toBe(true);
});

test("sendSudoCalls dispatches through sendUserOp, and the old path is the original call unchanged", () => {
  const kernel = fs.readFileSync("src/lib/kernel.ts", "utf8");
  expect(kernel).toContain("await sendUserOp({");
  expect(kernel).toContain("chainId: CHAIN.id,");
  expect(kernel).toContain("return await accountClient.sendUserOperation({ calls: args.calls });");
  expect(kernel).toMatch(/legacy: async \(\) => \{\s*try \{\s*return await accountClient\.sendUserOperation\(\{ calls: args\.calls \}\);\s*\} catch \(cause\) \{\s*throw sponsorFailure \?\? cause;\s*\}\s*\}/);
  // 其他呼叫者沒有帶 onSubmitted。
  for (const file of ["src/features/fund/FundPage.tsx", "src/features/fund/AccountControls.tsx", "src/lib/approval-batches.ts"]) {
    const source = fs.readFileSync(file, "utf8");
    expect(source).not.toContain("onSubmitted");
  }
});
