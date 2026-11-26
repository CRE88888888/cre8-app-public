import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { handleMixName } from "../src/features/mix/mix-math";

// 使用者 2026-11-21：My mix 的預設名稱用 X handle 加序號，「0xJoooe 1」、「0xJoooe 2」。

test("the number is how many mixes you already have (exited ones too) plus one", () => {
  expect(handleMixName("0xJoooe", [])).toBe("0xJoooe 1");
  expect(handleMixName("0xJoooe", ["NVDA + BTC"])).toBe("0xJoooe 2");
  expect(handleMixName("@0xJoooe", ["a", "b"])).toBe("0xJoooe 3");
});

test("a name that is already taken moves up until it is free (case does not matter)", () => {
  expect(handleMixName("0xJoooe", ["0xjoooe 2"])).toBe("0xJoooe 3");
  expect(handleMixName("0xJoooe", ["0xJoooe 3", "x", "0xJoooe 4"])).toBe("0xJoooe 5");
  expect(handleMixName("0xJoooe", ["0xJoooe 1", "0xJoooe 2"])).toBe("0xJoooe 3");
});

test("only new mixes use the handle; Change mix and shared-link copies keep their names, and a typed name always wins", () => {
  const builder = fs.readFileSync("src/features/mix/MixBuilderPage.tsx", "utf8");
  expect(builder).toContain("!editing && draft.importCode === null && signedIn && handle !== null ? handle : null");
  expect(builder).toContain("const name = draft.name.trim() || autoName;");
  expect(builder).toContain("if (draft.name.trim() === '' && handleName !== null)");
  expect(builder).toContain(": defaultMixName(draft.symbols);");
});
