/**
 * 基金列表的分組（使用者 2026-11-20，首發 21 檔）：依後端 `category` 分成 Themes／People／Leveraged，
 * 沒分類（null、舊資料、不認得的值）的放最後。正式版面等整站重新設計。
 */
export const FUND_GROUPS = [
  { id: 'theme', name: 'Themes', one: 'Theme' },
  { id: 'person', name: 'People', one: 'Person' },
  { id: 'leveraged', name: 'Leveraged', one: 'Leveraged' },
] as const;

export type FundGroupId = (typeof FUND_GROUPS)[number]['id'] | 'other';

export const OTHER_GROUP = { id: 'other', name: 'Other funds', one: 'Fund' } as const;

export function groupOf(category: unknown): FundGroupId {
  return FUND_GROUPS.find((group) => group.id === category)?.id ?? 'other';
}

/** 依固定順序分組；空的組不回傳。組內維持原本的順序。 */
export function groupFunds<T extends { category?: string | null }>(items: readonly T[]): { id: FundGroupId; name: string; one: string; items: T[] }[] {
  return [...FUND_GROUPS, OTHER_GROUP]
    .map((group) => ({ id: group.id, name: group.name, one: group.one, items: items.filter((item) => groupOf(item.category) === group.id) }))
    .filter((group) => group.items.length > 0);
}
