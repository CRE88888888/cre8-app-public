import { useEffect } from 'react';
import type { RefObject } from 'react';

/** 頁首實際高度寫在 :root 的這個變數；側欄 sticky 的 top 用它，才不會鑽到頁首底下。 */
export const MASTHEAD_HEIGHT_VAR = '--masthead-h';

/** 把頁首高度寫進 CSS 變數（四捨五入到整數 px）。 */
export function publishMastheadHeight(height: number, root: { style: { setProperty(name: string, value: string): void } }): void {
  root.style.setProperty(MASTHEAD_HEIGHT_VAR, `${Math.round(height)}px`);
}

/**
 * 頁首在中等寬度會折成兩列（約 125px，不是 64px）。原本側欄寫死 `top: 88px`，下單面板上緣的
 * Buy／Sell 會被頁首蓋住、點不到（使用者 2026-11-17）。這裡量頁首實際高度，變了就更新。
 */
export function useMastheadHeight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const header = ref.current;
    if (header === null || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => publishMastheadHeight(header.getBoundingClientRect().height, root));
    observer.observe(header);
    publishMastheadHeight(header.getBoundingClientRect().height, root);
    return () => {
      observer.disconnect();
      root.style.removeProperty(MASTHEAD_HEIGHT_VAR);
    };
  }, [ref]);
}
