import { expect, test } from "bun:test";
import fs from "node:fs";
import { privyChain, readPrivyAppId } from "../src/lib/privy-config";
import { accountAddress, usableSessionToken } from "../src/lib/use-connected-session";

// cre8-app#57：session 能不能用、以及「沒設定 App ID 就維持原樣」這條底線。

const OWNER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const OTHER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const live = { token: "t", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), address: OWNER };
const expired = { ...live, expiresAt: new Date(Date.now() - 1_000).toISOString() };

test("a SIWE session is only usable with the wallet that signed it (unchanged)", () => {
  for (const via of ["siwe", null] as const) {
    expect(usableSessionToken({ ...live, via, walletAddress: OWNER.toLowerCase() })).toBe("t");
    expect(usableSessionToken({ ...live, via, walletAddress: null })).toBeNull();
    expect(usableSessionToken({ ...live, via, walletAddress: OTHER })).toBeNull();
  }
});

test("a Privy session works without a wallet (view only), never with someone else's wallet", () => {
  // 主人錢包連著：可以用。
  expect(usableSessionToken({ ...live, via: "privy", walletAddress: OWNER })).toBe("t");
  // 錢包註冊者用 Google 登入：沒有連錢包，仍然可以看。
  expect(usableSessionToken({ ...live, via: "privy", walletAddress: null })).toBe("t");
  // 連著別的錢包：不能用，免得拿它去簽主人的帳戶。
  expect(usableSessionToken({ ...live, via: "privy", walletAddress: OTHER })).toBeNull();
  expect(usableSessionToken({ ...expired, via: "privy", walletAddress: null })).toBeNull();
  expect(usableSessionToken({ token: null, expiresAt: null, address: null, via: null, walletAddress: null })).toBeNull();
  expect(usableSessionToken({ ...live, address: null, via: "privy", walletAddress: null })).toBeNull();
});

test("who the user is: the connected wallet, or the Privy session's owner when viewing only", () => {
  expect(accountAddress({ ...live, via: "privy", walletAddress: null })).toBe(OWNER);
  expect(accountAddress({ ...live, via: "privy", walletAddress: OWNER.toLowerCase() })).toBe(OWNER.toLowerCase());
  // SIWE：沒連錢包就是沒有人（原本的行為）。
  expect(accountAddress({ ...live, via: "siwe", walletAddress: null })).toBeNull();
  expect(accountAddress({ ...expired, via: "privy", walletAddress: null })).toBeNull();
});

test("no app id means Privy is off", () => {
  expect(readPrivyAppId(undefined)).toBeNull();
  expect(readPrivyAppId("")).toBeNull();
  expect(readPrivyAppId("   ")).toBeNull();
  expect(readPrivyAppId(" cmabc123 ")).toBe("cmabc123");
});

test("the Privy chain follows the app's chain id", () => {
  expect(privyChain(56).id).toBe(56);
  expect(privyChain(56).name).toBe("BNB Smart Chain");
  // T 段：BSC 測試網。
  expect(privyChain(97).id).toBe(97);
  expect(privyChain(97).testnet).toBe(true);
  // 有給 RPC 就用它；相對路徑（dev 的 /rpc proxy）不是 Privy 能用的網址，忽略。
  expect(privyChain(97, "https://rpc.example/97").rpcUrls.default.http).toEqual(["https://rpc.example/97"]);
  expect(privyChain(97, "/rpc").rpcUrls.default.http).toEqual(privyChain(97).rpcUrls.default.http);
  // 本機 fork。
  const local = privyChain(1337, "http://127.0.0.1:8545");
  expect([local.id, local.rpcUrls.default.http[0], local.nativeCurrency.symbol]).toEqual([1337, "http://127.0.0.1:8545", "BNB"]);
  expect(privyChain(1337).rpcUrls.default.http).toEqual(["http://127.0.0.1:8545"]);
});

// 下面三條用原始碼守住（真正的驗證是 build 後看產物，見 PR）。

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sources(file, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(file);
  }
  return out;
}

test("only PrivyRoot imports the Privy SDK, and the app only loads it when an app id is set", () => {
  const importers = sources("src").filter((file) => /from ['"]@privy-io\//.test(fs.readFileSync(file, "utf8")));
  expect(importers).toEqual(["src/features/auth/PrivyRoot.tsx"]);
  const app = fs.readFileSync("src/App.tsx", "utf8");
  expect(app).toContain("PRIVY_ENABLED ? lazy(() => import('./features/auth/PrivyRoot')) : null");
  expect(app).not.toMatch(/^import .*PrivyRoot/m);
  const others = sources("src").filter((file) => file !== "src/App.tsx" && fs.readFileSync(file, "utf8").includes("features/auth/PrivyRoot'"));
  expect(others).toEqual([]);
});

test("the app id is never hard-coded", () => {
  const config = fs.readFileSync("src/lib/privy-config.ts", "utf8");
  expect(config).toContain("readPrivyAppId(import.meta.env.VITE_PRIVY_APP_ID)");
  for (const file of sources("src")) {
    // Privy 的 App ID 是 25 個字元、`c` 開頭的 cuid。
    expect([file, /['"`]c[a-z0-9]{24}['"`]/.test(fs.readFileSync(file, "utf8"))]).toEqual([file, false]);
  }
});

test("linking is refused until there is a CRE8 session, and the config matches the work order", () => {
  const root = fs.readFileSync("src/features/auth/PrivyRoot.tsx", "utf8");
  expect(root).toContain("if (!latest.current.privySession) return;");
  expect(root).toContain("embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' }, showWalletUIs: false }");
  expect(fs.readFileSync("src/lib/privy-config.ts", "utf8")).toContain("['email', 'google', 'twitter', 'wallet']");
  // 加綁的按鈕只在已登入的那一段畫面裡。
  const menu = fs.readFileSync("src/components/PrivyWalletMenu.tsx", "utf8");
  expect(menu.indexOf("actions?.link(kind)")).toBeGreaterThan(menu.indexOf("Signed in</p>"));
});

test("our own sign-in screen does not load the Privy SDK and offers the four ways in", () => {
  const screen = fs.readFileSync("src/components/SignInScreen.tsx", "utf8");
  expect(screen).not.toMatch(/@privy-io\//);
  for (const label of ["Continue with Google", "Continue with X", "Continue with email", "Connect a wallet"]) expect(screen).toContain(label);
  // 使用者 2026-11-15：不用 Apple 了（要自己的開發者憑證）。
  expect(screen).not.toMatch(/Apple|'apple'/);
  // Google 在前、X 第二。
  expect(screen.indexOf("Continue with Google")).toBeLessThan(screen.indexOf("Continue with X"));
  expect(screen.indexOf("Continue with X")).toBeLessThan(screen.indexOf("Continue with email"));
  // Google／X 走 headless 轉址（X 在 Privy 叫 twitter）；錢包只開 Privy 的選錢包視窗。
  expect(screen).toContain("onClick={() => oauth('twitter')}");
  const root = fs.readFileSync("src/features/auth/PrivyRoot.tsx", "utf8");
  expect(root).toContain("useLoginWithOAuth");
  expect(root).toContain("useLoginWithEmail");
  expect(root).toContain("login({ loginMethods: ['wallet'] })");
});
