import { expect, test } from "bun:test";
import type { SessionKeyReport } from "../src/lib/api";
import { isPermissionFailure, renewedMessage, tradingPermissionHealth } from "../src/lib/trading-permission";

const NOW = Date.parse("2026-11-13T00:00:00Z");
const DAY = 86_400_000;
const key = (expiresAt: string | null) => ({ permissionId: "0x01", keyRef: "sk-1", expiresAt, status: "active" });
const iso = (ms: number) => new Date(ms).toISOString();

test("a usable key far from expiry is active and needs nothing", () => {
  const report: SessionKeyReport = { configured: { ...key(iso(NOW + 200 * DAY)), installed: true }, usable: key(iso(NOW + 200 * DAY)), error: null };
  const health = tradingPermissionHealth(report, NOW);
  expect(health.state).toBe("active");
  expect(health.needsAction).toBe(false);
  expect(health.daysLeft).toBe(200);
  expect(health.detail).toContain("until");
});

test("a usable key inside the last week asks for renewal", () => {
  const report: SessionKeyReport = { configured: null, usable: key(iso(NOW + 3 * DAY + 1000)), error: null };
  const health = tradingPermissionHealth(report, NOW);
  expect(health.state).toBe("expiring");
  expect(health.tone).toBe("warn");
  expect(health.label).toBe("Expires in 4d");
  expect(health.needsAction).toBe(true);
});

test("no usable key and no read error means trading is off", () => {
  const missing = tradingPermissionHealth({ configured: null, usable: null, error: null }, NOW);
  expect(missing.state).toBe("missing");
  expect(missing.needsAction).toBe(true);

  const expired = tradingPermissionHealth(
    { configured: { ...key(iso(NOW - DAY)), installed: true }, usable: null, error: null },
    NOW,
  );
  expect(expired.state).toBe("expired");
  expect(expired.tone).toBe("bad");
  expect(expired.detail).toContain("12 Nov 2026");
});

test("a read error is never reported as 'no permission'", () => {
  const health = tradingPermissionHealth({ configured: null, usable: null, error: "rpc down" }, NOW);
  expect(health.state).toBe("unknown");
  expect(health.needsAction).toBe(false);
  expect(tradingPermissionHealth(undefined, NOW).state).toBe("unknown");
  expect(tradingPermissionHealth(null, NOW).state).toBe("unknown");
});

test("a usable key without an expiry date is still active", () => {
  const health = tradingPermissionHealth({ configured: null, usable: key(null), error: null }, NOW);
  expect(health.state).toBe("active");
  expect(health.daysLeft).toBeNull();
});

test("sell failures caused by the permission are recognised", () => {
  expect(isPermissionFailure("closing the position failed: SESSION_KEY_DERIVATION_MISMATCH seed + sk-1 …")).toBe(true);
  expect(isPermissionFailure("selling the shortfall failed: DB 記的 session key 是 0xabc")).toBe(true);
  expect(isPermissionFailure("BEP20: transfer amount exceeds balance")).toBe(false);
});

test("the renewal message never claims the old permission was revoked", () => {
  const message = renewedMessage(Date.parse("2027-11-13T00:00:00Z") / 1000);
  expect(message).toContain("13 Nov 2027");
  expect(message).toContain("not revoked");
  expect(message).not.toMatch(/replaced|old permission (is|was) (revoked|removed)/i);
});
