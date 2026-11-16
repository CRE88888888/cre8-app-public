import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../src/lib/api";
import { gateView } from "../src/lib/waitlist";
import { APPROVAL_RETRIES, WAITLIST_APPROVED_EVENT, shouldRetryAfterApproval, signalWaitlistApproved } from "../src/lib/waitlist-signal";
import { recoverFromWaitlistPending } from "../src/features/waitlist/WaitlistScreen";
import { operatorWaitlistQuery } from "../src/features/operator/OperatorPage";

// #95 最後複審（總管 2026-11-17，d88666a）第 2–5 項。第 1 項在 review-95.test.ts 的第 4 項。

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const pending = new ApiError(403, "WAITLIST_PENDING", "waitlist approval is required; sign in with X");

test("2. once the waitlist says approved, a session exchange blocked by WAITLIST_PENDING is retried (a bounded number of times)", () => {
  expect(shouldRetryAfterApproval(pending, 0)).toBe(true);
  expect(shouldRetryAfterApproval(pending, APPROVAL_RETRIES - 1)).toBe(true);
  // 名單說放行、換 session 還是 403：次數用完就停，不會無限來回。
  expect(shouldRetryAfterApproval(pending, APPROVAL_RETRIES)).toBe(false);
  // 其他失敗不因為放行而重來。
  for (const other of [null, new ApiError(403, "OPERATOR_FORBIDDEN", "no"), new ApiError(503, "WAITLIST_UNAVAILABLE", "down"), new Error("x")]) {
    expect(shouldRetryAfterApproval(other, 0)).toBe(false);
  }
  // 事件真的發得出去。
  const had = "window" in globalThis;
  if (!had) (globalThis as { window?: unknown }).window = new EventTarget();
  const win = (globalThis as unknown as { window: EventTarget }).window;
  let events = 0;
  const listener = () => { events += 1; };
  win.addEventListener(WAITLIST_APPROVED_EVENT, listener);
  signalWaitlistApproved();
  win.removeEventListener(WAITLIST_APPROVED_EVENT, listener);
  if (!had) delete (globalThis as { window?: unknown }).window;
  expect(events).toBe(1);
  // 接線：閘門看到 approved 就發事件；PrivyRoot 收到時清掉失敗（交換 effect 依 failure 重跑），成功或登出時歸零。
  const gate = fs.readFileSync("src/features/waitlist/WaitlistScreen.tsx", "utf8");
  expect(gate).toContain("if (WAITLIST_LOCKED && view === 'approved') signalWaitlistApproved();");
  const root = fs.readFileSync("src/features/auth/PrivyRoot.tsx", "utf8");
  expect(root).toContain("window.addEventListener(WAITLIST_APPROVED_EVENT, retry);");
  expect(root).toContain("if (!shouldRetryAfterApproval(failure, approvalRetries.current)) return;\n      approvalRetries.current += 1;\n      setFailure(null);");
  expect(root.match(/approvalRetries\.current = 0;/g)?.length).toBe(2);
});

test("3. WAITLIST_PENDING drops the cached approval at once: locked until the backend says approved again", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ["waitlist", "identity-token"];
  client.setQueryData(key, { record: { status: "approved", xHandle: "a", joinedAt: null }, inviteFailed: false });
  let cleared = 0;
  await recoverFromWaitlistPending(client, () => { cleared += 1; });
  expect(cleared).toBe(1);
  expect(client.getQueryData(key)).toBeUndefined();
  // 沒有紀錄時：重查中是 checking，重查失敗是 not-saved，都不是 approved。
  const base = { phase: "signed-in" as const, hasX: true, record: null };
  expect(gateView({ ...base, checking: true })).toBe("checking");
  expect(gateView({ ...base, checking: false, failed: true })).toBe("not-saved");
  client.clear();
});

test("4. the gate follows the router: leaving /operator re-checks the gate", () => {
  const gate = fs.readFileSync("src/features/waitlist/WaitlistScreen.tsx", "utf8");
  const body = gate.slice(gate.indexOf("export function WaitlistGate("), gate.indexOf("return <WaitlistScreen view={view}"));
  expect(body).toContain("const { pathname } = useLocation();");
  expect(body).toContain("if (!WAITLIST_LOCKED || isUngatedPath(pathname)) return children;");
  expect(body).not.toContain("window.location.pathname");
  // 閘門在 BrowserRouter 裡面（useLocation 才有路由可讀）。
  const main = fs.readFileSync("src/main.tsx", "utf8");
  expect(main.indexOf("<BrowserRouter>")).toBeGreaterThan(-1);
  expect(fs.readFileSync("src/App.tsx", "utf8")).toContain("<WaitlistGate>");
});

test("5. the operator waitlist loads past the first 100 with nextCursor; each filter starts from page one", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const second = url.includes("cursor=c1");
    const items = Array.from({ length: second ? 3 : 100 }, (_, i) => ({ id: `${second ? "b" : "a"}${i}`, xHandle: `h${i}`, xUserId: null, joinedAt: "2026-11-17T00:00:00Z", status: "waiting", approvedAt: null }));
    return new Response(JSON.stringify({ items, nextCursor: second ? null : "c1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient();
  const options = operatorWaitlistQuery("t", "waiting");
  const data = await client.fetchInfiniteQuery({ ...options, pages: 2 });
  expect(urls).toHaveLength(2);
  expect(urls[0]).toContain("/operator/waitlist?limit=100&status=waiting");
  expect(urls[0]).not.toContain("cursor=");
  expect(urls[1]).toContain("cursor=c1");
  expect(data.pages.flatMap((page) => page.items)).toHaveLength(103);
  // 最後一頁 nextCursor 是 null：沒有下一頁。
  expect(options.getNextPageParam(data.pages[1]!, data.pages, "c1", data.pageParams)).toBeNull();
  // 篩選在 queryKey 裡：換篩選是另一份清單（從第一頁）。
  expect(operatorWaitlistQuery("t", "approved").queryKey).not.toEqual(options.queryKey);
  const page = fs.readFileSync("src/features/operator/OperatorPage.tsx", "utf8");
  expect(page).toContain("const list = useInfiniteQuery(operatorWaitlistQuery(token, filter));");
  expect(page).toContain("{list.isFetchingNextPage ? 'Loading…' : 'Load more'}");
  client.clear();
});
