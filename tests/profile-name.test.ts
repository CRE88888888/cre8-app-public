import { expect, test } from "bun:test";
import fs from "node:fs";
import { DISPLAY_NAME_MAX, cleanDisplayName, displayNameOf, initialOf } from "../src/lib/profile-name";

// 使用者自己取的顯示名稱（使用者 2026-11-14：「用戶可以幫自己取名」）。

test("a typed name is tidied, not rejected", () => {
  expect(cleanDisplayName("  Ada   Lovelace \n")).toBe("Ada Lovelace");
  // 控制字元、零寬字元、方向控制字元都拿掉。
  expect(cleanDisplayName("A\u0000d\u200ba\u202e")).toBe("A d a");
  expect(cleanDisplayName("\t\n ")).toBe("");
  expect(cleanDisplayName("")).toBe("");
  // 中文、emoji 照樣可以用。
  expect(cleanDisplayName(" 小明 🚀 ")).toBe("小明 🚀");
});

test("the limit counts characters the way people see them", () => {
  expect(DISPLAY_NAME_MAX).toBe(24);
  expect(cleanDisplayName("a".repeat(40))).toBe("a".repeat(24));
  expect([...cleanDisplayName("名".repeat(40))].length).toBe(24);
  // emoji 是兩個 UTF-16 碼元，仍然算一個字，不會被切成半個。
  const rockets = cleanDisplayName("🚀".repeat(40));
  expect([...rockets].length).toBe(24);
  expect(rockets).toBe("🚀".repeat(24));
  // 截斷後尾巴的空白也去掉。
  expect(cleanDisplayName(`${"a".repeat(23)} bcd`)).toBe("a".repeat(23));
});

test("shown name: your own, then the linked account's, then nothing", () => {
  expect(displayNameOf({ custom: "Ada", linked: "Ada Lovelace" })).toBe("Ada");
  expect(displayNameOf({ custom: null, linked: "Ada Lovelace" })).toBe("Ada Lovelace");
  // 清掉自己取的（空白）就回到已綁帳號的名字。
  expect(displayNameOf({ custom: "   ", linked: "Ada Lovelace" })).toBe("Ada Lovelace");
  expect(displayNameOf({ custom: undefined, linked: null })).toBeNull();
  expect(displayNameOf({ custom: "", linked: "  " })).toBeNull();
});

test("avatar initial", () => {
  expect(initialOf("ada")).toBe("A");
  expect(initialOf("小明")).toBe("小");
  expect(initialOf("🚀 rocket")).toBe("🚀");
  expect(initialOf(null)).toBeNull();
  expect(initialOf("  ")).toBeNull();
});

test("the profile page has a sign-out button and an editable name", () => {
  const card = fs.readFileSync("src/features/portfolios/ProfileCard.tsx", "utf8");
  expect(card).toContain("Sign out");
  expect(card).toContain("Edit your name");
  const page = fs.readFileSync("src/features/portfolios/PortfoliosPage.tsx", "utf8");
  expect(page).toContain("<SignOutButton");
});
