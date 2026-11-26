/**
 * 基金封面（2026-11-20 改版，對齊新版首頁 CRE88888888/landing-redesign）：用後端的 `catalogKey` 找圖。
 *
 * 全部是版畫遮罩（透明背景、只有形狀），顏色由 CSS 決定：淺色版黃色色板配黑線，深色版深灰色板配黃線。
 * 人物（使用者 2026-11-20：「people 的圖重做，背景也用一樣的黃色」）多一張深色版用的反相遮罩（`srcDark`），
 * 臉在深色色板上才不會變成負片。沒有圖的基金回 null，畫面只有色板，不放假的圖。
 */
export type FundArt = { kind: 'ink'; src: string; srcDark?: string };

const INK = new Set([
  'mag7',
  'everyday',
  'ai-chips',
  'ai-memory',
  'ai-models',
  'crypto-treasuries',
  'bitcoin-plus',
  'china',
  'korea-semiconductors',
  'us-market',
  'tqqq',
  // 2026-11-20 補齊（Codex 圖像生成，同一套版畫）：開市鐘、柴犬配爆米花、起重機、吊橋塔、金條配硬幣、槓桿抬晶片。
  'new-giants',
  'meme',
  'bnb',
  'crypto-infrastructure',
  'gold-bitcoin',
  'soxl',
]);
const PEOPLE = new Set(['pelosi', 'trump', 'musk', 'duan']);

export function fundArt(catalogKey: string | null | undefined): FundArt | null {
  if (!catalogKey) return null;
  if (INK.has(catalogKey)) return { kind: 'ink', src: `/fund-art/${catalogKey}.webp` };
  if (PEOPLE.has(catalogKey)) return { kind: 'ink', src: `/fund-art/${catalogKey}.webp`, srcDark: `/fund-art/${catalogKey}-dark.webp` };
  return null;
}

/**
 * 首發 21 檔的英文名稱（App 介面是英文；後端名單 backend `test/fixtures/launch-lineup.json` 是中文）。
 * 首頁用過的名稱照首頁。對不到的基金沿用後端名稱。
 */
const LAUNCH_NAMES: Record<string, string> = {
  mag7: 'Mag7',
  everyday: 'Everyday brands',
  'ai-chips': 'AI chips',
  'ai-memory': 'AI memory',
  'ai-models': 'AI model makers',
  'new-giants': 'New giants',
  'korea-semiconductors': 'Korea semis',
  china: 'China tech',
  'crypto-treasuries': 'Crypto treasuries',
  'bitcoin-plus': 'Bitcoin plus',
  bnb: 'BNB ecosystem',
  'crypto-infrastructure': 'Crypto infrastructure',
  meme: 'Meme stocks',
  'gold-bitcoin': 'Gold + Bitcoin',
  'us-market': 'US market',
  pelosi: 'Nancy Pelosi',
  trump: 'Donald Trump',
  duan: 'Duan Yongping',
  musk: 'Elon Musk',
  soxl: '3x Semiconductors',
  tqqq: '3x Nasdaq',
};

export function launchName(catalogKey: string | null | undefined): string | undefined {
  return catalogKey ? LAUNCH_NAMES[catalogKey] : undefined;
}
