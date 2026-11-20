/**
 * 首發 21 檔的英文說明（C3 2026-11-20）：App 依 `catalogKey` 顯示，後端的中文說明不動（資訊與營運端用）。
 * 每檔一兩句：押的是什麼主題、核心成分是誰。不寫報酬、保證或買賣建議。成分照 backend `test/fixtures/launch-lineup.json`。
 * 對不到的基金退回後端原文。
 */
const LAUNCH_DESCRIPTIONS: Record<string, string> = {
  mag7: 'Seven of the largest US technology companies in equal weights: Apple, Microsoft, Alphabet, Amazon, NVIDIA, Meta and Tesla.',
  everyday: 'Companies people use every day. Apple, Amazon, Netflix, Alphabet, Meta and Microsoft make up the core in equal weights, with a small position in Reddit.',
  'ai-chips': 'The chipmakers behind AI computing. NVIDIA, TSMC, Intel and SK hynix make up the core, with small positions in Broadcom, Marvell and Penguin Solutions.',
  'ai-memory': 'The memory and storage makers that AI data centers depend on: SK hynix, Micron and SanDisk in equal weights.',
  'ai-models': 'Companies behind the leading AI models: Anthropic, Amazon, Alphabet, Microsoft, SpaceX and Meta in equal weights.',
  'new-giants': 'Two of the largest new names on the market, SpaceX and Anthropic, in equal weights.',
  'korea-semiconductors': 'Korea’s chip industry: SK hynix and a broad South Korea market fund (EWY) in equal weights.',
  china: 'Chinese e-commerce leaders Alibaba and PDD Holdings in equal weights.',
  'crypto-treasuries': 'Listed companies that hold crypto on their balance sheets. Strategy (MSTR), BitMine (BMNR) and BNC make up the core, with a small position in CYPH.',
  'bitcoin-plus': 'Bitcoin alongside two listed companies tied to it, Strategy (MSTR) and Coinbase, in equal weights.',
  bnb: 'The BNB Chain ecosystem: BNB itself and BNC, a listed company that holds BNB, in equal weights.',
  'crypto-infrastructure': 'The companies that move money in crypto: Circle, Coinbase and Robinhood in equal weights.',
  meme: 'Retail favourites. GameStop and Dogecoin make up the core, with small positions in AMC and Trump Media (DJT).',
  'gold-bitcoin': 'Two stores of value side by side: tokenized gold (XAUt) and bitcoin in equal weights.',
  'us-market': 'The broad US market through two index funds, the Nasdaq-100 (QQQ) and the S&P 500 (SPY), in equal weights.',
  pelosi: 'Built from the stock trades Nancy Pelosi’s household discloses to Congress. NVIDIA, Alphabet, Microsoft, Amazon and Intel make up the core, with a small position in Broadcom.',
  trump: 'Built from Donald Trump’s financial disclosures: NVIDIA, Apple, Microsoft, Amazon, Meta, Tesla, Alphabet and Netflix in equal weights.',
  duan: 'Built from the US stocks Duan Yongping reports in his public filings: Apple, PDD Holdings, NVIDIA and Tesla in equal weights.',
  musk: 'Elon Musk’s world. Tesla, SpaceX and bitcoin make up the core, with a small position in Dogecoin.',
  soxl: 'Three times the daily move of US semiconductor stocks, through a single 3x leveraged token (SOXL).',
  tqqq: 'Three times the daily move of the Nasdaq-100, through a single 3x leveraged token (TQQQ).',
};

/** 「Sources & methodology」裡的一句做法說明（首發 21 檔都是 monthly_drift，使用者 2026-11-20）。 */
export const LAUNCH_METHOD = 'CRE8 sets the target weights. The fund rebalances once a month, and whenever an asset moves more than 5 points from its weight.';

export function launchDescription(catalogKey: string | null | undefined): string | undefined {
  return catalogKey ? LAUNCH_DESCRIPTIONS[catalogKey] : undefined;
}
