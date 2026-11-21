import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { errorText, eventText, exitedText, marketNote } from "../src/features/mix/mix-copy";

// My mix 的文字（cre8-app#132）：全英文、白話，不用 rebalance／drift／bps／TP/SL／import／enroll／strategy。

const DIR = path.join(import.meta.dir, "../src/features/mix");
const BANNED = /\b(rebalanc\w*|drift|bps|tp\/sl|import|enroll\w*|strateg\w*)\b/i;

/** 畫面上會出現的字：JSX 文字節點，以及含空白或結尾標點的字串常值（程式識別字不算）。 */
function visibleText(source: string): string[] {
  const out: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1]!.trim());
  for (const m of code.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    // 樣板字串裡的 ${…} 是程式，不是畫面上的字。
    const text = m[2]!.replace(/\$\{[^}]*\}?/g, "");
    if (/[A-Za-z]/.test(text) && (/\s/.test(text) || /[.!?]$/.test(text)) && !/^[\w./-]+$/.test(text) && !text.includes("mx-")) out.push(text);
  }
  return out;
}

test("no screen uses the words we promised not to use", () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".tsx") || f === "mix-copy.ts");
  expect(files.length).toBeGreaterThan(4);
  const hits: string[] = [];
  for (const file of files) {
    for (const text of visibleText(fs.readFileSync(path.join(DIR, file), "utf8"))) {
      if (BANNED.test(text)) hits.push(`${file}: ${text}`);
    }
  }
  expect(hits).toEqual([]);
});

test("no screen text is Chinese", () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".tsx"));
  for (const file of files) {
    for (const text of visibleText(fs.readFileSync(path.join(DIR, file), "utf8"))) {
      expect(/[㐀-鿿]/.test(text) ? `${file}: ${text}` : "").toBe("");
    }
  }
});

test("a closed market is one plain sentence about when stocks buy", () => {
  const now = new Date("2026-11-21T09:30:00Z");
  const closed = [{ open: true, nextOpenAt: null }, { open: false, nextOpenAt: "2026-11-21T14:30:00Z" }];
  expect(marketNote(closed, true, now)).toBe("Crypto buys now. Stocks buy when the US market opens in 5h.");
  expect(marketNote(closed, false, now)).toBe("Stocks buy when the US market opens in 5h.");
  expect(marketNote([{ open: true, nextOpenAt: null }], true, now)).toBeNull();
  expect(marketNote([{ open: false, nextOpenAt: null }], false, now)).toBe("Stocks buy when the US market opens.");
});

test("after an exit the page says what was sold and where the money is", () => {
  const unit = 10n ** 18n;
  expect(exitedText({
    returnBps: "3000",
    currentValueRaw: (1300n * unit).toString(),
    events: [{ id: "1", at: "2026-11-21T10:00:00Z", kind: "mix_exit_triggered", message: "" }],
  })).toBe("Sold everything at +30% on Nov 21. 1,300 USDT is in your account.");
});

test("backend messages in Chinese are replaced by plain English", () => {
  expect(eventText({ kind: "mix_rebalanced", message: "已再平衡。" })).toBe("Auto-balanced back to your mix.");
  expect(eventText({ kind: "mix_rebalanced", message: "Auto-balanced: sold 12 USDT of NVDA." })).toBe("Auto-balanced: sold 12 USDT of NVDA.");
  expect(eventText({ kind: "mix_exit_triggered", message: "" })).toBe("Exit reached. Selling everything for USDT.");
});

test("every error tells you what to do next", () => {
  for (const code of ["INVALID_MIX_ASSETS", "MIX_BUSY", "MIX_NOT_FOUND", "MIX_ASSET_LIMIT", "MIX_PREVIEW_TIMEOUT", undefined, "WHATEVER"]) {
    const text = errorText(code);
    expect(text.split(". ").length).toBeLessThanOrEqual(2);
    expect(BANNED.test(text)).toBe(false);
  }
});
