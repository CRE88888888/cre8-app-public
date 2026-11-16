import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { createOperatorInvites, getOperatorInviteSummary, getOperatorInvites, revokeOperatorInvite } from "../src/lib/api";
import { buyingPausedText, parseBuyingPaused } from "../src/lib/fund-versions";
import { inviteFormProblem, inviteRequest } from "../src/features/operator/InvitesPanel";

// 總管 2026-11-16：backend#126（status 的 buyingPaused）與 #132（營運邀請碼）合併後接到 app。

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("buyingPaused is read strictly from the portfolio status", () => {
  expect(parseBuyingPaused({ reason: "NEW_VERSION_ACTIVE", joinedVersion: 1, activeVersion: 2 })).toEqual({ reason: "NEW_VERSION_ACTIVE", joinedVersion: 1, activeVersion: 2 });
  // 沒暫停（null／沒有欄位）或形狀不對：不暫停。
  for (const value of [null, undefined, {}, { reason: "OTHER", joinedVersion: 1, activeVersion: 2 }, { reason: "NEW_VERSION_ACTIVE", joinedVersion: 2, activeVersion: 2 },
    { reason: "NEW_VERSION_ACTIVE", joinedVersion: 0, activeVersion: 2 }, { reason: "NEW_VERSION_ACTIVE", joinedVersion: 1, activeVersion: 65_536 }, { reason: "NEW_VERSION_ACTIVE", joinedVersion: "1", activeVersion: 2 }]) {
    expect(parseBuyingPaused(value)).toBeNull();
  }
  expect(buyingPausedText({ reason: "NEW_VERSION_ACTIVE", joinedVersion: 1, activeVersion: 2 })).toBe(
    "Version 2 is now in effect. This portfolio was set up on version 1, so new buys into it are paused until portfolios can move to the new version (opening within a week). You can still sell, or take your assets out as they are, at any time.",
  );
});

test("the fund page pauses buying for an existing holder and says why; selling is untouched", () => {
  const page = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  expect(page).toContain("const buyingPaused = holding === undefined ? null : parseBuyingPaused(status.data?.buyingPaused);");
  expect(page).toContain("subscriptionLocked || buyingPaused !== null ||");
  expect(page).toContain('{buyingPaused !== null && <p className="fine warn" role="status" data-entry="buying-paused">{buyingPausedText(buyingPaused)}</p>}');
  // 買入流程一開始就擋，不轉錢。
  const guard = page.indexOf("if (buyingPaused !== null) throw new Error(`${buyingPausedText(buyingPaused)} Nothing was transferred.`);");
  expect(guard).toBeGreaterThan(page.indexOf("async function deposit("));
  expect(guard).toBeLessThan(page.indexOf("let account = holding?.smartAccounts[0]?.address;"));
});

test("the invite form checks the same limits as the backend before sending", () => {
  const NOW = Date.parse("2026-11-16T12:00:00Z");
  const base = { count: "10", issuedTo: "", batchNote: "", expiresOn: "" };
  expect(inviteFormProblem(base, NOW)).toBeNull();
  expect(inviteFormProblem({ ...base, count: "500" }, NOW)).toBeNull();
  for (const count of ["0", "501", "1.5", "", "-1", "abc"]) expect(inviteFormProblem({ ...base, count }, NOW)).toBe("Make between 1 and 500 codes at a time.");
  expect(inviteFormProblem({ ...base, issuedTo: "x".repeat(257) }, NOW)).toBe("Keep the recipient and the note under 256 characters.");
  expect(inviteFormProblem({ ...base, expiresOn: "2026-11-15" }, NOW)).toBe("Pick an expiry date in the future.");
  expect(inviteFormProblem({ ...base, expiresOn: "2026-11-16" }, NOW)).toBeNull();
  expect(inviteRequest({ count: "3", issuedTo: "  @alice ", batchNote: " ", expiresOn: "2026-12-01" })).toEqual({ count: 3, issuedTo: "@alice", batchNote: null, expiresAt: "2026-12-01T23:59:59.000Z" });
  expect(inviteRequest(base)).toEqual({ count: 10, issuedTo: null, batchNote: null, expiresAt: null });
});

test("invite admin calls the backend#132 operator endpoints with the session token", async () => {
  const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  }) as typeof fetch;
  await createOperatorInvites("t", { count: 2, issuedTo: "@alice", batchNote: null, expiresAt: null });
  await getOperatorInvites("t", { status: "used", batch: "b-1", cursor: "c-1" });
  await getOperatorInvites("t");
  await getOperatorInviteSummary("t");
  await revokeOperatorInvite("t", "42");
  expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
    "POST /api/operator/waitlist/invites",
    "GET /api/operator/waitlist/invites?limit=100&status=used&batch=b-1&cursor=c-1",
    "GET /api/operator/waitlist/invites?limit=100",
    "GET /api/operator/waitlist/invites/summary",
    "POST /api/operator/waitlist/invites/42/revoke",
  ]);
  expect(seen.every((call) => call.auth === "Bearer t")).toBe(true);
  expect(seen[0]!.body).toEqual({ count: 2, issuedTo: "@alice", batchNote: null, expiresAt: null });
  // 營運頁掛上邀請碼後台；明碼只在產生當下顯示，並提醒存下來。
  expect(fs.readFileSync("src/features/operator/OperatorPage.tsx", "utf8")).toContain("<InvitesPanel token={token} />");
  const panel = fs.readFileSync("src/features/operator/InvitesPanel.tsx", "utf8");
  expect(panel).toContain("They are shown only once and can’t be looked up later.");
  expect(panel).toContain("{row.codeMasked}");
});
