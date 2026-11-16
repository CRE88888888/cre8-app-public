import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { WaitlistScreen } from "../src/features/waitlist/WaitlistScreen";
import { postWaitlistJoin } from "../src/lib/api";
import { CRE8_X_HANDLE, FOLLOW_CRE8_URL, gateView, isLandingHost, isUngatedPath, parseWaitlist, readWaitlistFlag } from "../src/lib/waitlist";

// 使用者 2026-11-16：整站鎖成 waitlist，只有 Connect X 與 Follow @CRE8Finance on X；有過就過、沒過就等。

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("only an explicit approval from the backend lets anyone in", () => {
  const approved = { status: "approved" as const, xHandle: "alice", joinedAt: null };
  const waiting = { status: "waiting" as const, xHandle: "alice", joinedAt: null };
  expect(gateView({ phase: "loading", hasX: false, record: null, checking: false })).toBe("loading");
  expect(gateView({ phase: "unavailable", hasX: false, record: null, checking: false })).toBe("unavailable");
  expect(gateView({ phase: "signed-out", hasX: false, record: null, checking: false })).toBe("connect");
  // 用別的方式登入、沒有 X：要換成 X。
  expect(gateView({ phase: "signed-in", hasX: false, record: approved, checking: false })).toBe("switch-to-x");
  expect(gateView({ phase: "signed-in", hasX: true, record: null, checking: true })).toBe("checking");
  expect(gateView({ phase: "signed-in", hasX: true, record: waiting, checking: false })).toBe("waiting");
  expect(gateView({ phase: "signed-in", hasX: true, record: approved, checking: false })).toBe("approved");
  // 換 CRE8 session 失敗（預覽站 /api 回 PREVIEW_ONLY）不影響：有 X、後端說放行就放行；後端不通就是排隊中。
  expect(gateView({ phase: "error", hasX: true, record: approved, checking: false })).toBe("approved");
  expect(gateView({ phase: "error", hasX: true, record: null, checking: false })).toBe("waiting");
  expect(gateView({ phase: "exchanging", hasX: true, record: null, checking: false })).toBe("waiting");
});

test("odd backend answers never count as approved", () => {
  expect(parseWaitlist({ status: "approved", xHandle: "@alice", joinedAt: "2026-11-16T00:00:00Z" })).toEqual({ status: "approved", xHandle: "alice", joinedAt: "2026-11-16T00:00:00Z" });
  expect(parseWaitlist({ status: "waiting" })).toEqual({ status: "waiting", xHandle: null, joinedAt: null });
  for (const bad of [null, "approved", {}, { status: "APPROVED" }, { status: true }, { approved: true }]) expect(parseWaitlist(bad)).toBeNull();
});

test("joining sends only the Privy identity token, without a CRE8 session", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init };
    return new Response(JSON.stringify({ status: "waiting", xHandle: "alice", joinedAt: null }), { status: 200 });
  }) as typeof fetch;
  expect(parseWaitlist(await postWaitlistJoin("id-token"))).toEqual({ status: "waiting", xHandle: "alice", joinedAt: null });
  expect(seen!.url).toBe("/api/waitlist/join");
  expect(seen!.init?.method).toBe("POST");
  expect(JSON.parse(String(seen!.init?.body))).toEqual({ identityToken: "id-token" });
  expect((seen!.init?.headers as Record<string, string>).authorization).toBeUndefined();
});

test("hosts, flags and the operator exemption", () => {
  expect(isLandingHost("cre8.finance")).toBe(true);
  expect(isLandingHost("WWW.cre8.finance")).toBe(true);
  expect(isLandingHost("tst.cre8.finance")).toBe(false);
  expect(isUngatedPath("/operator")).toBe(true);
  expect(isUngatedPath("/operators")).toBe(false);
  expect(isUngatedPath("/vaults")).toBe(false);
  expect(readWaitlistFlag("1")).toBe(true);
  expect(readWaitlistFlag(undefined)).toBe(false);
  expect(readWaitlistFlag("0")).toBe(false);
  expect(fs.readFileSync(".env.production", "utf8")).toMatch(/^VITE_WAITLIST=1$/m);
  expect(FOLLOW_CRE8_URL).toBe("https://x.com/intent/follow?screen_name=CRE8Finance");
  expect(CRE8_X_HANDLE).toBe("CRE8Finance");
});

test("the waitlist shows only Connect X and Follow before connecting", () => {
  const html = renderToStaticMarkup(<WaitlistScreen view="connect" handle={null} avatarUrl={null} />);
  expect(html).toContain("CRE8 is invite-only");
  expect(html).toContain("Connect X");
  expect(html).toContain("Follow @CRE8Finance on X");
  expect(html).toContain('href="https://x.com/intent/follow?screen_name=CRE8Finance"');
  expect(html.match(/<button/g)?.length).toBe(1);
  expect(html.match(/<a /g)?.length).toBe(1);
  expect(html).not.toMatch(/Google|email|wallet/i);
  // 使用者 2026-11-16：拿掉「We’re letting people in a few at a time.」
  expect(html).not.toContain("letting people in");
});

test("after connecting, a waiting account sees its spot and can still follow", () => {
  const html = renderToStaticMarkup(<WaitlistScreen view="waiting" handle="alice" avatarUrl="https://pbs.twimg.com/a.jpg" />);
  expect(html).toContain("You’re on the list");
  expect(html).toContain("@alice · ");
  expect(html).toContain("Follow @CRE8Finance on X");
  expect(html).toContain("Use a different X account");
  expect(html).not.toContain(">Connect X<");
  expect(html).not.toContain("letting people in");
});

test("the whole app sits behind the gate, except the operator console", () => {
  const app = fs.readFileSync("src/App.tsx", "utf8");
  // 閘門包住所有頁面（TopBar、Routes），PrivyRoot 在閘門外面。
  const open = app.indexOf("<WaitlistGate>");
  expect(open).toBeGreaterThan(app.indexOf("{privy}"));
  expect(open).toBeLessThan(app.indexOf("<TopBar />"));
  expect(app.indexOf("</WaitlistGate>")).toBeGreaterThan(app.indexOf("</Routes>"));
  // App 本身不訂閱登入狀態（會讓 PrivyRoot 重繪成無限迴圈）。
  expect(app).not.toMatch(/useWaitlistGate|usePrivyAuth/);
  const gate = fs.readFileSync("src/features/waitlist/WaitlistScreen.tsx", "utf8");
  expect(gate).toContain("if (!WAITLIST_LOCKED || isUngatedPath(window.location.pathname)) return children;");
  expect(gate).toContain("if (view === 'approved') return isLandingHost(window.location.hostname) ? null : children;");
});

test("backend 409s: no X means connect X; an X account taken by another sign-in gets its own screen", () => {
  expect(gateView({ phase: "signed-in", hasX: true, record: null, checking: false, errorCode: "X_REQUIRED" })).toBe("switch-to-x");
  expect(gateView({ phase: "signed-in", hasX: true, record: null, checking: false, errorCode: "X_ALREADY_JOINED" })).toBe("x-taken");
  // 其他錯誤（429、503、網路）一律還在排隊，不放行。
  expect(gateView({ phase: "signed-in", hasX: true, record: null, checking: false, errorCode: "RATE_LIMITED" })).toBe("waiting");
  const html = renderToStaticMarkup(<WaitlistScreen view="x-taken" handle="alice" avatarUrl={null} />);
  expect(html).toContain("This X account is already on the list");
  expect(html).toContain("Use a different X account");
  expect(html).toContain("Follow @CRE8Finance on X");
});

test("operator list asks the backend with status, limit and cursor", async () => {
  const { getOperatorWaitlist } = await import("../src/lib/api");
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  }) as typeof fetch;
  await getOperatorWaitlist("t", "revoked");
  await getOperatorWaitlist("t", "all", "abc", 50);
  expect(urls).toEqual(["/api/operator/waitlist?limit=100&status=revoked", "/api/operator/waitlist?limit=50&cursor=abc"]);
});

test("the operator waitlist shows a no-permission note on 403 instead of an error or an empty list", () => {
  const page = fs.readFileSync("src/features/operator/OperatorPage.tsx", "utf8");
  const forbidden = page.indexOf("list.error instanceof ApiError && list.error.status === 403");
  expect(forbidden).toBeGreaterThan(-1);
  expect(forbidden).toBeLessThan(page.indexOf("<ErrorNote error={list.error} />"));
  expect(page).toContain("This account is not on the operator list, so it can’t see or approve the waitlist.");
  expect(page).toContain("const forbidden = cause instanceof ApiError && cause.status === 403;");
});
