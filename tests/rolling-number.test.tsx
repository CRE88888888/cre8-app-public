import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RollingNumber } from "../src/components/RollingNumber";

test("rolling number exposes the full value to assistive tech and hides the moving digits", () => {
  const html = renderToStaticMarkup(<RollingNumber value="+64.74%" />);
  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="+64.74%"');
  // 四個數字各自滾動；正負號、小數點、百分號是靜態字元。
  expect(html.match(/class="roll-digit"/g)).toHaveLength(4);
  expect(html.match(/class="roll-char"/g)).toHaveLength(3);
  // 每個數字滾到自己的值，延遲依序增加。
  expect(html).toContain("--roll-to:6;--roll-order:0");
  expect(html).toContain("--roll-to:4;--roll-order:3");
  expect(html).not.toMatch(/<span class="roll-(digit|char)"(?![^>]*aria-hidden="true")/);
});

test("a value without digits renders no reels", () => {
  const html = renderToStaticMarkup(<RollingNumber value="—" />);
  expect(html).not.toContain("roll-digit");
  expect(html).toContain('aria-label="—"');
});
