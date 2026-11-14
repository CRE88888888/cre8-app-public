import { expect, test } from "bun:test";
import { ApiError } from "../src/lib/api";
import {
  PrivySetupError,
  evmWallets,
  explainPrivyLoginFailure,
  identityTokenWallets,
  emailIdentity,
  linkableMethods,
  profileOf,
  readOnlyNotice,
  readRememberedOwner,
  rememberOwner,
  resolveOwner,
  signInMethods,
  type LinkedAccountLike,
} from "../src/lib/privy-owner";

// cre8-app#57：誰是錢包主人。後端（backend#65）在首次登入時把帳號上唯一的 EVM 錢包記成永久主人，
// 但回應裡沒有帶地址，所以前端要從 Privy 的帳號資料推回去。

const EMBEDDED = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
const METAMASK = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const SECOND = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

const embedded = (at = "2026-11-14T08:00:00Z"): LinkedAccountLike => ({
  type: "wallet", chainType: "ethereum", address: EMBEDDED, walletClientType: "privy", connectorType: "embedded", firstVerifiedAt: at,
});
const external = (address: string, at: string): LinkedAccountLike => ({
  type: "wallet", chainType: "ethereum", address, walletClientType: "metamask", connectorType: "injected", firstVerifiedAt: at,
});
const email: LinkedAccountLike = { type: "email", address: "ada@example.com", firstVerifiedAt: "2026-11-14T07:59:00Z" };
const google: LinkedAccountLike = { type: "google_oauth", email: "ada@gmail.com", firstVerifiedAt: "2026-11-15T00:00:00Z" };
const apple: LinkedAccountLike = { type: "apple_oauth", email: "ada@icloud.com", firstVerifiedAt: "2026-11-16T00:00:00Z" };

test("only valid, non-zero EVM wallets count, the same way the backend counts them", () => {
  const wallets = evmWallets([
    email,
    embedded(),
    // 同一個地址不同大小寫：算一個。
    { ...embedded(), address: EMBEDDED.toLowerCase() },
    { type: "wallet", chainType: "solana", address: "So11111111111111111111111111111111111111112" },
    { type: "wallet", chainType: "ethereum", address: "0x0000000000000000000000000000000000000000" },
    { type: "wallet", chainType: "ethereum", address: "0x1234" },
    { type: "smart_wallet", address: SECOND },
    external(METAMASK, "2026-11-20T00:00:00Z"),
  ]);
  expect(wallets.map((wallet) => [wallet.address, wallet.embedded])).toEqual([[EMBEDDED, true], [METAMASK, false]]);
  expect(evmWallets(null)).toEqual([]);
});

test("email sign-up: the embedded wallet is the owner", () => {
  expect(resolveOwner({ accounts: [email, embedded()] })).toEqual({ owner: EMBEDDED, source: "only-wallet" });
});

test("wallet sign-up: that one external wallet is the owner, also when Google is linked later", () => {
  const accounts = [external(METAMASK, "2026-11-14T08:00:00Z"), google];
  expect(resolveOwner({ accounts })).toEqual({ owner: METAMASK, source: "only-wallet" });
});

test("no EVM wallet on the account: the owner is unknown, not guessed", () => {
  expect(resolveOwner({ accounts: [email] })).toBeNull();
  expect(resolveOwner({ accounts: null })).toBeNull();
});

test("an address in the backend response wins over everything else", () => {
  const accounts = [embedded(), external(METAMASK, "2026-11-01T00:00:00Z")];
  expect(resolveOwner({ responseAddress: SECOND, accounts, remembered: METAMASK })).toEqual({ owner: SECOND, source: "backend" });
  // 無效的回應欄位當成沒有。
  expect(resolveOwner({ responseAddress: "0x0000000000000000000000000000000000000000", accounts: [embedded()] })?.source).toBe("only-wallet");
  expect(resolveOwner({ responseAddress: 42, accounts: [embedded()] })?.source).toBe("only-wallet");
});

test("several wallets: the one this device confirmed earlier, otherwise the earliest linked", () => {
  // email 註冊（嵌入式錢包先有），後來又綁了 MetaMask。
  const accounts = [external(METAMASK, "2026-11-20T00:00:00Z"), embedded("2026-11-14T08:00:00Z")];
  expect(resolveOwner({ accounts })).toEqual({ owner: EMBEDDED, source: "earliest" });
  // 這台裝置先前確定過 → 用記下的（寫法用帳號上的大小寫）。
  expect(resolveOwner({ accounts, remembered: METAMASK.toLowerCase() })).toEqual({ owner: METAMASK, source: "remembered" });
  // 主人已經不在帳號上（被解除綁定）：後端不會換主人，所以仍以記下的為準。
  expect(resolveOwner({ accounts: [embedded()], remembered: SECOND })).toEqual({ owner: SECOND, source: "remembered" });
  // 讀不到綁定時間的排最後；都讀不到時維持 Privy 給的順序。
  expect(resolveOwner({ accounts: [{ ...external(METAMASK, ""), firstVerifiedAt: null }, embedded()] })?.owner).toBe(EMBEDDED);
  expect(resolveOwner({ accounts: [{ ...external(METAMASK, ""), firstVerifiedAt: null }, { ...embedded(), firstVerifiedAt: null }] })?.owner).toBe(METAMASK);
});

test("only a certain owner is remembered, per Privy user", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
  rememberOwner(storage, "did:privy:a", { owner: EMBEDDED, source: "only-wallet" });
  rememberOwner(storage, "did:privy:b", { owner: METAMASK, source: "backend" });
  // 推測出來的不記。
  rememberOwner(storage, "did:privy:c", { owner: SECOND, source: "earliest" });
  rememberOwner(storage, "did:privy:a", { owner: SECOND, source: "earliest" });
  expect(readRememberedOwner(storage, "did:privy:a")).toBe(EMBEDDED);
  expect(readRememberedOwner(storage, "did:privy:b")).toBe(METAMASK);
  expect(readRememberedOwner(storage, "did:privy:c")).toBeNull();
  // storage 壞掉或被擋：當成沒有，不丟錯。
  data.set("cre8.privyOwner", "{not json");
  expect(readRememberedOwner(storage, "did:privy:a")).toBeNull();
  expect(readRememberedOwner(null, "did:privy:a")).toBeNull();
  expect(() => rememberOwner(null, "did:privy:a", { owner: EMBEDDED, source: "backend" })).not.toThrow();
  expect(() => rememberOwner({ getItem: () => { throw new Error("blocked"); }, setItem: () => undefined }, "x", { owner: EMBEDDED, source: "backend" })).not.toThrow();
});

/** 組一個長得像 Privy identity token 的 JWT（不簽名；前端本來就不驗）。 */
function fakeToken(linked: unknown, encodeAsString = true): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "ES256" })}.${part({ sub: "did:privy:a", linked_accounts: encodeAsString ? JSON.stringify(linked) : linked })}.sig`;
}

test("reads which wallets an identity token already carries", () => {
  // 登入當下發的 token：還沒有嵌入式錢包。
  expect(identityTokenWallets(fakeToken([{ type: "email", address: "ada@example.com" }]))).toEqual([]);
  // 建好之後重發的。
  expect(identityTokenWallets(fakeToken([{ type: "wallet", chain_type: "ethereum", address: EMBEDDED }, { type: "wallet", chain_type: "solana", address: "x" }])))
    .toEqual([EMBEDDED.toLowerCase()]);
  expect(identityTokenWallets(fakeToken([{ type: "wallet", chain_type: "ethereum", address: METAMASK }], false))).toEqual([METAMASK.toLowerCase()]);
  // 看不懂的 token：回 null（呼叫端就不擋，直接交給後端判斷）。
  for (const bad of [null, undefined, "", "abc", "a.b.c", fakeToken("nope"), `${"x"}.${Buffer.from("{}").toString("base64url")}.s`]) {
    expect(identityTokenWallets(bad)).toBeNull();
  }
});

test("lists how the account can sign in, and what can still be added", () => {
  const methods = signInMethods([email, embedded(), google, external(METAMASK, "2026-11-20T00:00:00Z")]);
  // 嵌入式錢包不是登入方式。
  expect(methods).toEqual([
    { kind: "email", detail: "ada@example.com" },
    { kind: "google", detail: "ada@gmail.com" },
    { kind: "wallet", detail: "0x90F7…b906" },
  ]);
  // 已經有信箱（email 與 Google 都算），只剩 X 可以綁；錢包不提供再綁。
  expect(linkableMethods(methods)).toEqual(["x"]);
  expect(linkableMethods(signInMethods([apple]))).toEqual(["x"]);
  expect(linkableMethods([])).toEqual(["google", "x"]);
});

test("every backend answer to /auth/privy has its own plain-English message", () => {
  const cases: [unknown, string, string][] = [
    [new ApiError(409, "PRIVY_NO_WALLET", "Complete your first CRE8 login with exactly one valid nonzero EVM wallet before linking additional wallets"), "still being set up", "retry"],
    [new ApiError(409, "PRIVY_OWNER_AMBIGUOUS", "Complete your first CRE8 login with exactly one valid nonzero EVM wallet before linking additional wallets"), "more than one wallet", "none"],
    [new ApiError(401, "UNAUTHORIZED", "invalid or expired Privy identity token"), "expired", "sign-in-again"],
    [new ApiError(503, "PRIVY_UNAVAILABLE", "Privy login is unavailable"), "not available right now", "retry"],
    [new ApiError(429, "RATE_LIMITED", "too many requests"), "Too many sign-in attempts", "retry"],
    [new ApiError(0, "NETWORK", "Failed to fetch"), "could not be reached", "retry"],
    [new ApiError(500, "INTERNAL", "boom"), "could not be completed", "retry"],
    [new PrivySetupError("NO_WALLET"), "still being set up", "retry"],
    [new PrivySetupError("NO_IDENTITY_TOKEN"), "did not return your identity", "retry"],
    [new Error("popup closed"), "could not be completed", "retry"],
    ["weird", "could not be completed", "retry"],
  ];
  for (const [error, text, action] of cases) {
    const failure = explainPrivyLoginFailure(error);
    expect(failure.message).toContain(text);
    expect(failure.action).toBe(action as typeof failure.action);
    // 主要訊息不帶代碼與後端原文；那些在 technical。
    expect(failure.message).not.toMatch(/PRIVY_|[A-Z]{3,}_[A-Z]/);
    expect(failure.technical.length).toBeGreaterThan(0);
  }
  expect(explainPrivyLoginFailure(new ApiError(409, "PRIVY_OWNER_AMBIGUOUS", "x")).technical).toBe("409 · PRIVY_OWNER_AMBIGUOUS\nx");
});

test("view-only notice: names the owner wallet, or says the embedded wallet is not here", () => {
  // 錢包註冊者用 Google 登入：主人是外部錢包，沒有連著。
  expect(readOnlyNotice({ owner: METAMASK, ownerEmbedded: false, signer: "missing" })).toBe(
    "You can view this account, but buying, selling and withdrawing need its owner wallet 0x90F7…b906. Connect that wallet to continue.",
  );
  expect(readOnlyNotice({ owner: EMBEDDED, ownerEmbedded: true, signer: "missing" })).toContain("Sign out and sign in again");
  // 可以簽、還在確認、或沒登入：不顯示。
  expect(readOnlyNotice({ owner: METAMASK, ownerEmbedded: false, signer: "ready" })).toBeNull();
  expect(readOnlyNotice({ owner: METAMASK, ownerEmbedded: false, signer: "checking" })).toBeNull();
  expect(readOnlyNotice({ owner: null, ownerEmbedded: false, signer: "missing" })).toBeNull();
});

test("profile: name, handle and picture come from X first, then Google, then the email address", () => {
  const x: LinkedAccountLike = { type: "twitter_oauth", username: "ada_l", name: "Ada L.", profilePictureUrl: "https://pbs.twimg.com/profile_images/1/abc_normal.jpg" };
  expect(profileOf([email, embedded(), x, google])).toEqual({ name: "Ada L.", handle: "ada_l", avatarUrl: "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg" });
  // 沒有 X：Google 的名字；沒有頭像。
  expect(profileOf([email, { ...google, name: "Ada Lovelace" }])).toEqual({ name: "Ada Lovelace", handle: null, avatarUrl: null });
  // 只有 email：@ 前面那段。
  expect(profileOf([email, embedded()])).toEqual({ name: "ada", handle: null, avatarUrl: null });
  // X 沒有名字：用 @帳號。
  expect(profileOf([{ type: "twitter_oauth", username: "ada_l", name: " " }]).name).toBe("ada_l");
  // 只有錢包：沒有名字（畫面改顯示地址）。
  expect(profileOf([external(METAMASK, "2026-11-14T08:00:00Z")])).toEqual({ name: null, handle: null, avatarUrl: null });
  // 不是 https 的頭像網址不用。
  expect(profileOf([{ ...x, profilePictureUrl: "http://example.com/a_normal.jpg" }]).avatarUrl).toBeNull();
});

test("X can be linked once and shows the @handle", () => {
  const methods = signInMethods([email, embedded(), { type: "twitter_oauth", username: "ada_l", name: "Ada" }]);
  expect(methods).toEqual([{ kind: "email", detail: "ada@example.com" }, { kind: "x", detail: "@ada_l" }]);
  expect(linkableMethods(methods)).toEqual([]);
  expect(linkableMethods([])).toContain("x");
});

test("email, Google and Apple are one thing to the user: a single email identity", () => {
  // 使用者 2026-11-14：「email 跟 google 不是一樣的嗎？」
  expect(emailIdentity(signInMethods([google]))).toEqual({ kind: "google", detail: "ada@gmail.com" });
  expect(emailIdentity(signInMethods([email, embedded()]))).toEqual({ kind: "email", detail: "ada@example.com" });
  expect(emailIdentity(signInMethods([apple]))).toEqual({ kind: "apple", detail: "ada@icloud.com" });
  // 兩種都綁過：顯示 Google 的。
  expect(emailIdentity(signInMethods([email, google]))?.kind).toBe("google");
  // 用錢包註冊的人沒有信箱：可以綁 Google。
  const walletOnly = signInMethods([external(METAMASK, "2026-11-14T08:00:00Z")]);
  expect(emailIdentity(walletOnly)).toBeNull();
  expect(linkableMethods(walletOnly)).toEqual(["google", "x"]);
});

test("a second wallet is never offered: one person, one wallet", () => {
  // 使用者 2026-11-14：「為啥有兩個錢包，我們應該不是這樣設計的」。
  for (const accounts of [[email, embedded()], [google], [external(METAMASK, "2026-11-14T08:00:00Z")], []]) {
    expect(linkableMethods(signInMethods(accounts))).not.toContain("wallet");
  }
});
