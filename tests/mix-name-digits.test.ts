import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MixNameText } from "../src/features/mix/MixParts";
import { eventText } from "../src/features/mix/mix-copy";

// 總管 2026-11-21：名稱的「0」在襯線標題裡像「O」（cre8admin 看成 Ocre8admin）；Recent 第一筆不能還沒買就寫 bought。

test("digits in a mix name use the mono font, letters stay in the title font", () => {
  expect(renderToStaticMarkup(createElement(MixNameText, { name: "0xadmin 3" })))
    .toBe('<span class="mx-digits">0</span>xadmin <span class="mx-digits">3</span>');
  expect(renderToStaticMarkup(createElement(MixNameText, { name: "NVDA + BTC" }))).toBe("NVDA + BTC");
  expect(renderToStaticMarkup(createElement(MixNameText, { name: "Top 10" }))).toBe('Top <span class="mx-digits">10</span>');
});

test("every place that shows a mix name uses MixNameText; lining-nums is not used (the font has no other digits)", () => {
  const read = (f: string) => fs.readFileSync(`src/features/mix/${f}`, "utf8");
  expect(read("MyMixesPage.tsx")).toContain("<h3><MixNameText name={mix.name} /></h3>");
  expect(read("MixPage.tsx")).toContain("<span><MixNameText name={mix.name} /></span>");
  expect(read("SharedMixPage.tsx")).toContain('<h1 className="mx-title"><MixNameText name={mix.name} /></h1>');
  expect(read("ShareSheet.tsx")).toContain('<b className="mx-sharecard-name"><MixNameText name={name} /></b>');
  // 新建頁的大標是輸入框的 placeholder：沒填名字時疊一層 MixNameText，placeholder 透明。
  expect(read("MixBuilderPage.tsx")).toContain(`{draft.name === '' && <span className="mx-name-auto" aria-hidden="true"><MixNameText name={autoName} /></span>}`);
  const css = fs.readFileSync("src/styles/my-mix.css", "utf8");
  expect(css).toContain(".mx-digits { font-family: var(--mono);");
  expect(css).toContain("#root .mx-name input.is-auto::placeholder { color: transparent; }");
});

// 後端 mix-store.ts 寫的中文訊息（畫面換英文）。
const ENROLLED = { kind: "mix_enrolled" as const, message: "私人組合已建立，將依設定處理買入。" };
const BOUGHT = { kind: "mix_rebalanced" as const, message: "已依組合設定完成一批買入或再平衡。" };

test("a new mix says it will buy soon until a trade is recorded", () => {
  expect(eventText(ENROLLED, [ENROLLED])).toBe("Mix created. Buying soon.");
  expect(eventText(ENROLLED)).toBe("Mix created. Buying soon.");
  const events = [BOUGHT, ENROLLED];
  expect(eventText(ENROLLED, events)).toBe("Mix created.");
  expect(eventText(BOUGHT, events)).toBe("First buy done.");
});

test("later rebalances keep the usual line; nothing says bought without a trade", () => {
  const second = { ...BOUGHT };
  const events = [second, BOUGHT, ENROLLED];
  expect(eventText(second, events)).toBe("Auto-balanced back to your mix.");
  expect(eventText(BOUGHT, events)).toBe("First buy done.");
  const changed = { kind: "mix_allocation_changed" as const, message: "新比例已生效；收盤中的股票會於開盤交易。" };
  const afterChange = { ...BOUGHT };
  expect(eventText(afterChange, [afterChange, changed, BOUGHT, ENROLLED])).toBe("Auto-balanced back to your mix.");
  const src = fs.readFileSync("src/features/mix/mix-copy.ts", "utf8");
  expect(src).not.toContain("created and bought");
  expect(fs.readFileSync("src/features/mix/MixPage.tsx", "utf8")).toContain("eventText(event, mix.events)");
});
