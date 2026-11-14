import { expect, test } from "bun:test";
import fs from "node:fs";
import { FEATURES, featureLock, featureState, parseFeatureOverrides, playLock, type FeatureKey } from "../src/lib/feature-flags";

// cre8-app#58：還不能用的功能看得到、灰色、點不動；每一項的開關集中在 lib/feature-flags.ts。

test("the defaults match what the testnet shows as not yet available", () => {
  const states = Object.fromEntries(Object.keys(FEATURES).map((key) => [key, featureState(key as FeatureKey, {})]));
  expect(states).toEqual({
    // 主網才開放。
    depositCard: "mainnet",
    depositCrossChain: "mainnet",
    ondoStocks: "mainnet",
    // 第二批，還沒做好。
    strategyDca: "soon",
    strategyDips: "soon",
    strategyLimits: "soon",
    idleYield: "soon",
    performanceFee: "soon",
    settingsDelay: "soon",
    // 設計稿有、v1 不做。
    strategyRange: "later",
    strategyTrend: "later",
    strategyLp: "later",
    strategyCarry: "later",
  });
});

test("a locked feature carries its badge and a one-sentence explanation", () => {
  expect(featureLock("depositCard", {})).toEqual({
    feature: "depositCard",
    state: "mainnet",
    label: "Mainnet",
    name: "Card or Apple Pay",
    note: "Buy USDT with a card or Apple Pay, sent straight to your account. Opens on mainnet.",
  });
  expect(featureLock("strategyDca", {})?.label).toBe("Coming soon");
  expect(featureLock("strategyCarry", {})?.label).toBe("Later");
  for (const key of Object.keys(FEATURES) as FeatureKey[]) {
    const lock = featureLock(key, {});
    expect(lock).not.toBeNull();
    // 每一項都有名稱與一句完整的說明，而且說明講了什麼時候開放。
    expect(lock!.name.length).toBeGreaterThan(3);
    expect(lock!.note).toMatch(/\.$/);
    expect(lock!.note).toMatch(lock!.state === "mainnet" ? /Opens on mainnet\.$/ : lock!.state === "soon" ? /Coming soon to testnet\.$/ : /later release\.$/);
  }
});

test("turning a flag on removes the lock; nothing else changes", () => {
  expect(featureLock("strategyDca", { strategyDca: "on" })).toBeNull();
  expect(featureLock("strategyDips", { strategyDca: "on" })?.state).toBe("soon");
  // 也可以換成另一種鎖著的狀態（例如刷卡先標成即將推出）。
  expect(featureLock("depositCard", { depositCard: "soon" })?.label).toBe("Coming soon");
});

test("deployment overrides: only known names and states are accepted", () => {
  expect(parseFeatureOverrides(undefined)).toEqual({});
  expect(parseFeatureOverrides("")).toEqual({});
  expect(parseFeatureOverrides(" strategyDca = on , depositCard=soon,")).toEqual({ strategyDca: "on", depositCard: "soon" });
  // 打錯的名稱、不存在的狀態、少了等號：都忽略，不會意外打開任何東西。
  expect(parseFeatureOverrides("strategyDCA=on,idleYield=yes,performanceFee,=on,toString=on,__proto__=on")).toEqual({});
  expect(parseFeatureOverrides("idleYield=on,idleYield=later")).toEqual({ idleYield: "later" });
});

test("strategies: buy & hold is always open, every other one follows its flag", () => {
  expect(playLock("hold", {})).toBeNull();
  expect(Object.fromEntries(["stack", "dips", "custom", "range", "trend", "lp", "carry"].map((play) => [play, playLock(play, {})?.feature]))).toEqual({
    stack: "strategyDca",
    dips: "strategyDips",
    custom: "strategyLimits",
    range: "strategyRange",
    trend: "strategyTrend",
    lp: "strategyLp",
    carry: "strategyCarry",
  });
  expect(playLock("stack", { strategyDca: "on" })).toBeNull();
  // 不認得的策略名稱不鎖（交給設計器原本的規則）。
  expect(playLock("something-new", {})).toBeNull();
});

// 下面用原始碼守住兩件事：灰色入口不做任何事；狀態只從這一個檔案來。

test("a locked entry only toggles its own explanation: no navigation, no request", () => {
  const lock = fs.readFileSync("src/components/FeatureLock.tsx", "utf8");
  expect(lock).toContain('aria-disabled="true"');
  expect(lock).toContain("onClick={() => setShown((current) => !current)}");
  expect(lock).not.toMatch(/fetch\(|href=|navigate\(|<Link|<a\s|lib\/api/);
  const funding = fs.readFileSync("src/components/FundingMethods.tsx", "utf8");
  expect(funding).not.toMatch(/fetch\(|href=|navigate\(|<Link|<a\s|lib\/api|onClick/);
  expect(funding).toContain('feature="depositCard"');
  expect(funding).toContain('feature="depositCrossChain"');
});

test("every feature name used on a page exists in the flag file", () => {
  const known = new Set(Object.keys(FEATURES));
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (!file.startsWith("src/reference")) walk(file); continue; }
      if (!/\.tsx?$/.test(entry.name) || file === "src/lib/feature-flags.ts") continue;
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/featureLock\("([A-Za-z]+)"\)|feature="([A-Za-z]+)"/g)) used.add(match[1] ?? match[2]!);
    }
  };
  walk("src");
  expect([...used].filter((name) => !known.has(name))).toEqual([]);
  // 策略以外的每一項都真的用在某個頁面上（策略經由 playLock 對應）。
  const direct = [...known].filter((name) => !name.startsWith("strategy"));
  expect(direct.filter((name) => !used.has(name))).toEqual([]);
});
