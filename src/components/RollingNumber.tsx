import type { CSSProperties, ReactNode } from "react";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * 主數字的進場：每個數字從 0 滾到自己的值，一次，很短。沒有外框或底色，就是一個普通的大數字。
 *
 * 只用在「一個畫面的主數字」（Funds 主打牌的報酬、基金頁的報酬、Portfolio 的總值），不要拿來顯示表格裡的一般數字。
 * 螢幕閱讀器讀到的是完整字串（`aria-label`），滾動的數字都是 `aria-hidden`。
 * `prefers-reduced-motion` 時不滾動，直接顯示結果（規則在 system.css）。
 * 換值時想重播，呼叫端用 `key={value}`。
 */
export function RollingNumber({ value, className = "" }: { value: string; className?: string }): ReactNode {
  let order = 0;
  return (
    <span className={`roll ${className}`.trim()} role="img" aria-label={value}>
      {[...value].map((char, index) =>
        /\d/.test(char) ? (
          <span className="roll-digit" key={index} aria-hidden="true"
            style={{ "--roll-to": Number(char), "--roll-order": order++ } as CSSProperties}>
            <span className="roll-reel">
              {DIGITS.map((digit) => <i key={digit}>{digit}</i>)}
            </span>
          </span>
        ) : (
          <span className="roll-char" key={index} aria-hidden="true">{char}</span>
        ),
      )}
    </span>
  );
}
