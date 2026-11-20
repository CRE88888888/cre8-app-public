import type { ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import { setTheme, useTheme } from '../lib/theme';

/**
 * 深色／淺色切換。桌機放在頁首右側（只有圖示）；手機放在 Profile 的 Account 面板（`variant="row"`，一列文字＋按鈕）。
 * 圖示畫的是「按下去會變成的樣子」，aria-label 寫出動作。
 */
export function ThemeToggle({ variant = 'icon' }: { variant?: 'icon' | 'row' }): ReactNode {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'light' ? 'Switch to light theme' : 'Switch to dark theme';
  const icon = next === 'light' ? <Sun size={18} strokeWidth={1.8} aria-hidden="true" /> : <Moon size={18} strokeWidth={1.8} aria-hidden="true" />;
  const button = (
    <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={() => setTheme(next)}>
      {icon}
      {variant === 'row' && <span>{next === 'light' ? 'Light' : 'Dark'}</span>}
    </button>
  );
  if (variant === 'icon') return button;
  return (
    <div className="theme-row">
      <span>Theme: {theme === 'dark' ? 'Dark' : 'Light'}</span>
      {button}
    </div>
  );
}
