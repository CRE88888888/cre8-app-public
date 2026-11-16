import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FollowVersionsTerms, VersionNotice } from "../src/features/fund/VersionNotice";
import { FOLLOW_VERSIONS_TERMS_TEXT, type VersionSchedule } from "../src/lib/atp-contracts";

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const BTC = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
const ZERO = `0x${"0".repeat(64)}`;
const symbolOf = (asset: string) => ({ [USDT]: "USDT", [BTC]: "BTCB", [ETH]: "ETH" })[asset.toLowerCase()] ?? asset;
const later = Math.floor(Date.now() / 1000) + 20 * 3600;
const schedule = (pending: boolean, active = true): VersionSchedule => ({
  registry: "0x7D39178401923140dF8b5A559a02682326F17350",
  strategyId: 5n,
  active: active ? { version: 1, activeAt: 100, settingsHash: ZERO, performanceFeeBps: 1_000, assets: [{ asset: USDT, weightBps: 1_000 }, { asset: BTC, weightBps: 6_000 }, { asset: ETH, weightBps: 3_000 }] } : null,
  pending: pending ? { version: 2, activeAt: later, settingsHash: ZERO, performanceFeeBps: 800, assets: [{ asset: USDT, weightBps: 1_000 }, { asset: BTC, weightBps: 9_000 }] } : null,
  lastPublishedAt: Math.floor(Date.now() / 1000) - 3600,
  historicalAssets: [USDT, BTC, ETH],
});

test("holders see when the new settings take effect, what changes, and a way out", () => {
  const html = renderToStaticMarkup(<VersionNotice schedule={schedule(true)} versions={[]} symbolOf={symbolOf} onExit={() => {}} creator={null} />);
  expect(html).toContain("New settings take effect on");
  expect(html).toContain("BTCB: 60% → 90%");
  expect(html).toContain("Removes ETH (was 30%). You can still sell what you hold; it is no longer bought.");
  expect(html).toContain("Performance fee: 10% → 8%");
  expect(html).toContain("Exit before then");
  expect(html).not.toContain("Cancel the new settings");
});

test("the creator gets a cancel button; visitors without a position get no exit link", () => {
  const html = renderToStaticMarkup(<VersionNotice schedule={schedule(true)} versions={[]} symbolOf={symbolOf} onExit={null} creator={{ onCancel: () => {}, cancelling: false }} />);
  expect(html).toContain("Cancel the new settings");
  expect(html).toContain("You can cancel the new settings any time before they take effect.");
  expect(html).not.toContain("Exit before then");
});

test("a fund whose first settings are still pending says when it opens", () => {
  const html = renderToStaticMarkup(<VersionNotice schedule={schedule(true, false)} versions={[]} symbolOf={symbolOf} onExit={null} creator={null} />);
  expect(html).toContain("This fund opens for buying on");
});

test("nothing pending: holders see nothing, the creator sees when they can publish again", () => {
  expect(renderToStaticMarkup(<VersionNotice schedule={schedule(false)} versions={[]} symbolOf={symbolOf} onExit={() => {}} creator={null} />)).toBe("");
  const creator = renderToStaticMarkup(<VersionNotice schedule={schedule(false)} versions={[]} symbolOf={symbolOf} onExit={null} creator={{ onCancel: () => {}, cancelling: false }} />);
  expect(creator).toContain("You can publish new settings again on");
});

test("the consent shows the plain version and the exact signed text", () => {
  const html = renderToStaticMarkup(<FollowVersionsTerms terms={FOLLOW_VERSIONS_TERMS_TEXT} />);
  expect(html).toContain("follows the new version automatically");
  expect(html).toContain("Only a lower performance fee can take effect right away.");
  expect(html).toContain(FOLLOW_VERSIONS_TERMS_TEXT);
});
