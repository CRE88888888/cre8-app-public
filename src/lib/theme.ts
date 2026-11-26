/**
 * 主題（BNB family，2026-11-20）：`<html data-theme="light">` 是淺色，沒有屬性是深色。
 * 預設淺色，跟新版首頁一樣（使用者 2026-11-20）：index.html 一開始就帶著 light，選過深色的人才拿掉。
 * 選擇記在 localStorage（`cre8.theme`）；index.html 在第一次繪製前就讀它設好屬性，不會閃一下。
 * 色票與規則在 src/styles/theme-dark.css（深色）與 theme-bnb.css（淺色與共用）。
 */
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

export const THEME_KEY = 'cre8.theme';
/** 狀態列（加到主畫面時）跟頁面同色。 */
const THEME_COLOR: Record<Theme, string> = { dark: '#0B0E11', light: '#FFFFFF' };

export function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

const listeners = new Set<() => void>();

export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 私密視窗或封鎖儲存：這次照樣切換，只是不記住。
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => 'light');
}
