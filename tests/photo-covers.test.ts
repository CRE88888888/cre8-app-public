import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { PHOTO_COVER_SLUGS, REFERENCE_METADATA } from "../src/lib/public-funds";
import { TESTNET_LISTED_SLUGS } from "../src/lib/testnet-catalogue";

// 使用者 2026-11-18：基金封面改成寫實照（深綠底、西裝風衣墨鏡的主角），測試網沒有的基金先不放。

test("the 16 listed funds use the photo covers; the hedcut covers are gone (cre8-app#123)", () => {
  expect([...PHOTO_COVER_SLUGS].sort()).toEqual([...TESTNET_LISTED_SLUGS].sort());
  expect(fs.existsSync("public/fund-covers/hedcut")).toBe(false);
  for (const [slug, meta] of Object.entries(REFERENCE_METADATA)) {
    if (PHOTO_COVER_SLUGS.has(slug)) {
      expect(meta.cover.art).toBe("photo");
      expect(meta.cover.src).toBe(`/fund-covers/photo/${slug}.webp`);
      expect(meta.cover.thumbnailSrc).toBe(`/fund-covers/photo/${slug}-thumb.webp`);
      expect(fs.existsSync(path.join("public", meta.cover.src))).toBe(true);
      expect(fs.existsSync(path.join("public", meta.cover.thumbnailSrc))).toBe(true);
    } else {
      // 沒列出的 14 檔不顯示；封面退回同步資料原本的值，不再指向點畫圖。
      expect(meta.cover.src).not.toContain("/hedcut/");
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

test("Mag7 cover is the full 1536x1024 group shot with a square 256 thumbnail (v8 A, natural proportions)", () => {
  // 使用者 2026-11-19 選 A 版（前排三人、後排四人，肩寬正常）；圖要維持原尺寸，封面裁切才對得上。
  const size = (file: string) => {
    const b = fs.readFileSync(path.join("public/fund-covers/photo", file));
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (chunk === "VP8L") { const v = b.readUInt32LE(21); return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1]; }
    return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  };
  expect(size("mag7.webp")).toEqual([1536, 1024]);
  expect(size("mag7-thumb.webp")).toEqual([256, 256]);
});
