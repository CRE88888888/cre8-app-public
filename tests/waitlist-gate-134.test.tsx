import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { ApiError, getPortfolios } from "../src/lib/api";
import { explainPrivyLoginFailure } from "../src/lib/privy-owner";
import { WAITLIST_PENDING_EVENT, isWaitlistPending } from "../src/lib/waitlist-signal";

// backend#134（總管 2026-11-17）：未放行回 403 WAITLIST_PENDING；只有營運錢包能用 SIWE。

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function signalsFor(status: number, code: string): Promise<{ events: number; error: unknown }> {
  // 測試環境沒有 DOM：給一個只會收發事件的 window，用完拿掉。
  const had = "window" in globalThis;
  const target = new EventTarget();
  if (!had) (globalThis as { window?: unknown }).window = target;
  const win = (globalThis as unknown as { window: EventTarget }).window;
  let events = 0;
  const listener = () => { events += 1; };
  win.addEventListener(WAITLIST_PENDING_EVENT, listener);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code, message: "waitlist approval is required; sign in with X" } }), { status })) as typeof fetch;
  let error: unknown = null;
  try { await getPortfolios("t"); } catch (cause) { error = cause; }
  win.removeEventListener(WAITLIST_PENDING_EVENT, listener);
  if (!had) delete (globalThis as { window?: unknown }).window;
  return { events, error };
}

test("a 403 WAITLIST_PENDING from any API call tells the waitlist gate, other errors do not", async () => {
  const pending = await signalsFor(403, "WAITLIST_PENDING");
  expect(pending.events).toBe(1);
  expect(pending.error).toBeInstanceOf(ApiError);
  expect(isWaitlistPending(pending.error)).toBe(true);
  for (const [status, code] of [[403, "OPERATOR_FORBIDDEN"], [401, "UNAUTHORIZED"], [503, "WAITLIST_UNAVAILABLE"]] as const) {
    const other = await signalsFor(status, code);
    expect(other.events).toBe(0);
    expect(isWaitlistPending(other.error)).toBe(false);
  }
});

test("the gate clears the session and asks the waitlist again instead of showing an error", () => {
  const gate = fs.readFileSync("src/features/waitlist/WaitlistScreen.tsx", "utf8");
  expect(gate).toContain("window.addEventListener(WAITLIST_PENDING_EVENT, recover);");
  expect(gate).toContain("clearSession();");
  expect(gate).toContain("return queryClient.resetQueries({ queryKey: ['waitlist'] });");
  // 掛在 WaitlistGate 一開始（/operator 這種不鎖的頁面也會清 session）。
  expect(gate.indexOf("useWaitlistPendingRecovery();")).toBeLessThan(gate.indexOf("if (!WAITLIST_LOCKED || isUngatedPath(pathname)) return children;"));
  // Privy 換 session 被擋時不顯示技術錯誤或重試。
  expect(explainPrivyLoginFailure(new ApiError(403, "WAITLIST_PENDING", "waitlist approval is required; sign in with X"))).toEqual({
    message: "Your spot on the waitlist isn’t open yet. You can sign in once it is.",
    action: "none",
    technical: "",
  });
});

test("the operator console signs in with X first, with an operator wallet (SIWE) as the fallback", () => {
  // 使用者 2026-11-17：管理員是 X 帳號 @cre8admin（它的 Privy 錢包在後端 OPERATOR_WALLETS）。
  const page = fs.readFileSync("src/features/operator/OperatorPage.tsx", "utf8");
  expect(page.indexOf("<WalletMenu inline />")).toBeGreaterThan(-1);
  expect(page.indexOf("<summary>Use an operator wallet instead</summary>")).toBeGreaterThan(page.indexOf("<WalletMenu inline />"));
  expect(page).toContain("<OperatorWalletMenu inline />");
  const menu = fs.readFileSync("src/components/WalletMenu.tsx", "utf8");
  expect(menu).toContain("export function OperatorWalletMenu(props: Omit<WalletMenuProps, 'signInFor'>): ReactNode {\n  return <ClassicWalletMenu {...props} />;");
  expect(menu).toContain("Wallet sign-in is only for CRE8 operator wallets. Everyone else signs in with X.");
});
