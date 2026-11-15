import type { ReactNode } from 'react';

/**
 * 成功的打勾：先畫圓，再畫勾，共約 470ms（使用者分享的第二支影片「Draw the win」）。
 *
 * 只用在「一件事真的完成了」的那一刻（下單結果）。兩段都用 `pathLength={1}`，CSS 只要把
 * `stroke-dashoffset` 從 1 動到 0（規則在 mobile-app.css 的 `.success-tick`）。
 * `prefers-reduced-motion` 時不畫，直接顯示完成的樣子。
 */
export function SuccessTick({ size = 22 }: { size?: number }): ReactNode {
  return (
    <svg className="success-tick" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="success-tick__circle" cx="12" cy="12" r="10" pathLength={1} />
      <path className="success-tick__check" d="M7.5 12.5l3 3 6-6.5" pathLength={1} />
    </svg>
  );
}
