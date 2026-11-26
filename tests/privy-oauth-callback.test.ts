import { expect, test } from "bun:test";
import fs from "node:fs";
import { PRIVY_CODE_VERIFIER_KEY, deadOAuthCallbackPath } from "../src/lib/privy-oauth-callback";

// cre8-app#107：X 登入成功後，帶著已用掉的 code 再載入，Privy 會跳出「Authentication failed」。

const store = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });
const callback = "https://tst.cre8.finance/?privy_oauth_state=s1&privy_oauth_code=c1&privy_oauth_provider=twitter";

test("a callback whose code can still be redeemed (code verifier present) is left alone", () => {
  expect(deadOAuthCallbackPath(callback, store({ [PRIVY_CODE_VERIFIER_KEY]: '"v"' }))).toBeNull();
  expect(PRIVY_CODE_VERIFIER_KEY).toBe("privy:code_verifier");
});

test("a used code (no code verifier in this browser) is removed from the URL, other params and hash kept", () => {
  expect(deadOAuthCallbackPath(callback, store({}))).toBe("/");
  expect(deadOAuthCallbackPath("https://tst.cre8.finance/vaults?sort=aum&privy_oauth_code=c1&privy_oauth_state=s1&privy_oauth_provider=twitter&period=1Y#x", store({})))
    .toBe("/vaults?sort=aum&period=1Y#x");
  // 讀不到 localStorage（Privy 也讀不到）同樣當成兌換不了。
  expect(deadOAuthCallbackPath(callback, null)).toBe("/");
  expect(deadOAuthCallbackPath(callback, { getItem: () => { throw new Error("blocked"); } })).toBe("/");
});

test("URLs without a Privy code are never touched", () => {
  expect(deadOAuthCallbackPath("https://tst.cre8.finance/funds/mag7?period=1Y", store({}))).toBeNull();
  expect(deadOAuthCallbackPath("not a url", store({}))).toBeNull();
});

test("main.tsx drops a dead callback before React Router and Privy read the URL", () => {
  const main = fs.readFileSync("src/main.tsx", "utf8");
  const call = main.indexOf("dropDeadOAuthCallback();");
  expect(call).toBeGreaterThan(0);
  expect(call).toBeLessThan(main.indexOf("createRoot(container).render("));
});
