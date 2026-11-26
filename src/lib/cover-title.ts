/**
 * 封面名稱最長那個字有幾個字元（2026-11-17）。CSS 用它算字級：名稱只能放在人像左邊，
 * 一個字不能折行，所以最長的字決定字要多小才放得下（`--title-word`，見 styles/covers.css）。
 */
export function longestWordLength(text: string): number {
  const words = text.split(/[\s·]+/).filter((word) => word.length > 0);
  return words.length === 0 ? 1 : Math.max(...words.map((word) => [...word].length));
}
