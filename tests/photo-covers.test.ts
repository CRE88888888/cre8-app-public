import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { PHOTO_COVER_SLUGS, REFERENCE_METADATA } from "../src/lib/public-funds";
import { TESTNET_LISTED_SLUGS } from "../src/lib/testnet-catalogue";

// 使用者 2026-11-18：基金封面改成寫實照（深綠底、西裝風衣墨鏡的主角），測試網沒有的基金先不放。

test("the 16 testnet funds use the photo covers; the rest keep their hedcut", () => {
  expect([...PHOTO_COVER_SLUGS].sort()).toEqual([...TESTNET_LISTED_SLUGS].sort());
  for (const [slug, meta] of Object.entries(REFERENCE_METADATA)) {
    if (PHOTO_COVER_SLUGS.has(slug)) {
      expect(meta.cover.art).toBe("photo");
      expect(meta.cover.src).toBe(`/fund-covers/photo/${slug}.webp`);
      expect(meta.cover.thumbnailSrc).toBe(`/fund-covers/photo/${slug}-thumb.webp`);
      expect(fs.existsSync(path.join("public", meta.cover.src))).toBe(true);
      expect(fs.existsSync(path.join("public", meta.cover.thumbnailSrc))).toBe(true);
    } else {
      expect(meta.cover.art).toBe("hedcut");
    }
  }
});

test("people covers align high so the wall lettering and the whole head show on the wide desktop cover", () => {
  expect(REFERENCE_METADATA["ken-griffin-citadel"].cover.position).toBe(22);
  expect(REFERENCE_METADATA["ken-griffin-citadel"].cover.subject).toBe("person");
  expect(REFERENCE_METADATA["raoul-pal-x"].cover.subject).toBe("person");
  expect(REFERENCE_METADATA["treasury-reserve"].cover.subject).toBe("object");
  expect(REFERENCE_METADATA["treasury-reserve"].cover.position).toBe(50);
});

test("photo covers have no gradient and keep the title and buttons on the dark left side", () => {
  const css = fs.readFileSync("src/styles/covers.css", "utf8");
  expect(css).toContain("#atp-fund-cover.is-photo .atp-fund-cover-shade { display: none; }");
  expect(css).toContain(".vault-heading:has(#atp-fund-cover.is-photo) .atp-fund-byline { right: auto; left: 28px; bottom: 24px; }");
  const overview = fs.readFileSync("src/features/reference/FundOverview.tsx", "utf8");
  expect(overview).toContain('meta?.cover.art === "photo" ? " is-photo"');
});
