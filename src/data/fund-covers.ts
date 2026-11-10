/** 已合併的正式 UI 封面；只負責呈現，不參與策略比對、估值或交易。 */
export type FundCover = { src: string; thumbnail: string };

const presets: Record<string, string> = {
  'ai-buildout': 'ai-20261109-r3',
  mag7: 'mag7-20261109-r3',
  'multi-asset-balanced': 'balanced-20261109-r3',
  'crypto-leaders': 'crypto-20261109-r3',
  'treasury-reserve': 'treasury-20261109-r3',
  'elon-universe': 'elon-20261109',
  'pelosi-disclosed-equity': 'pelosi-20261109',
  'berkshire-disclosed-equities': 'buffett-20261109',
  'trump-universe': 'trump-20261109',
};

export function fundCover(slug: string): FundCover | undefined {
  const preset = presets[slug];
  return preset === undefined ? undefined : {
    src: `/fund-covers/${preset}.webp`,
    thumbnail: `/fund-covers/${preset}-thumb.webp`,
  };
}
