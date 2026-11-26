import { expect, test } from "bun:test";
import fs from "node:fs";
import { ApiError } from "../src/lib/api";
import { explainPrivyLoginFailure } from "../src/lib/privy-owner";

// 總管＋使用者 2026-11-15：先在臨時網址用手機試 Privy 登入。

test("the production build carries only the public Privy App ID, never a secret", () => {
  const env = fs.readFileSync(".env.production", "utf8");
  const lines = env.split("\n").filter((line) => /^[A-Z_]+=/.test(line));
  const privy = lines.filter((line) => line.includes("PRIVY"));
  expect(privy).toHaveLength(1);
  expect(privy[0]).toMatch(/^VITE_PRIVY_APP_ID=[a-z0-9]{20,40}$/);
  // 沒有任何像憑證的鍵。
  for (const line of lines) expect(line.split("=")[0]).not.toMatch(/SECRET|PRIVATE|KEY$|TOKEN|PASSWORD/);
});

test("on the preview the failed session exchange is explained plainly, without technical details", () => {
  const failure = explainPrivyLoginFailure(new ApiError(503, "PREVIEW_ONLY", "App preview"));
  expect(failure).toEqual({
    message: "This preview isn’t connected to CRE8’s servers yet. What you can do after signing in opens on the testnet.",
    action: "none",
    technical: "",
    preview: true,
  });
  // 其他 503 仍是原本的說明。
  expect(explainPrivyLoginFailure(new ApiError(503, "PRIVY_UNAVAILABLE", "x")).preview).toBeUndefined();
  const menu = fs.readFileSync("src/components/PrivyWalletMenu.tsx", "utf8");
  expect(menu).toContain("{failure.preview ? 'Preview only' : 'Sign-in not completed'}");
  expect(menu).toContain("<Note tone={failure.preview ? 'neutral' : 'bad'}>");
});
