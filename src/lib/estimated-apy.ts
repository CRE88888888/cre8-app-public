/**
 * 基金卡上的報酬改成推估年化（使用者 2026-11-20：「用 APY or APR，用推估的」）。
 *
 * 用模型淨值（後端 backend#173 的 `modelNav`；目錄基金用內建回測）頭尾兩點，依實際天數複利年化：
 *   APY = (最後 ÷ 最前) ^ (365 ÷ 天數) − 1
 * 歷史太短（少於 APY_MIN_DAYS 天）年化出來的數字沒意義，回 null，畫面顯示「—」。
 * 這是回測推估，不是實績，也不是保證的收益率。
 */
export const APY_MIN_DAYS = 30;

export type NavPoint = { t: number; v: number };

export function estimatedApy(series: readonly NavPoint[] | null | undefined): { apy: number; days: number } | null {
  const points = (series ?? []).filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v) && point.v > 0);
  if (points.length < 2) return null;
  const first = points[0]!, last = points[points.length - 1]!;
  const days = (last.t - first.t) / 86_400_000;
  if (!(days >= APY_MIN_DAYS)) return null;
  const apy = (Math.pow(last.v / first.v, 365 / days) - 1) * 100;
  return Number.isFinite(apy) ? { apy, days } : null;
}

/** 後端 `modelNav: [{ date, value }]` 換成 {t, v}；格式不對的點直接略過。 */
export function navFromApi(modelNav: unknown): NavPoint[] {
  if (!Array.isArray(modelNav)) return [];
  return modelNav
    .map((point) => ({ t: Date.parse(String((point as { date?: unknown })?.date)), v: Number((point as { value?: unknown })?.value) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
    .sort((a, b) => a.t - b.t);
}
