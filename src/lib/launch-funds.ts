/**
 * 展示基金哪幾檔上線時可投資（cre8-app#51）。
 *
 * 沒有另外一份基金名單：一檔基金「可投資」＝它的目標成分全部在 `launch-admission.ts` 的清單裡。
 * 所以之後清單多一個資產，成分因此補齊的基金會自動變成可投資，不用改這裡。
 * 目前算出來是 5 檔（Mag7、Elon Universe、Raoul Pal、Ming-Chi Kuo、Lyn Alden），
 * 與 docs#32 的結論相同；`tests/launch-admission.test.ts` 會釘住這個結果，
 * 目錄資料或清單一變動造成名單改變，測試就會提醒。
 *
 * 只是標示，不擋交易：已經持有部位的人必須照常能賣出（見 FundPage 裡移除 whitelist 閘門的說明）。
 */
import { MOCK_FUNDS } from '../data/mock-funds';
import { LAUNCH_COPY, notOpenSymbols } from './launch-admission';

export type FundLaunchStatus = {
  /** `open` = 成分全部可上架；`preview` = 展示中，尚未開放投資。 */
  status: 'open' | 'preview';
  /** 還不能上架的成分（鏈上符號）；`open` 時是空的。 */
  missing: string[];
};

const STATUS_BY_SLUG: ReadonlyMap<string, FundLaunchStatus> = new Map(
  MOCK_FUNDS.map((fund) => {
    const missing = notOpenSymbols(fund.holdings);
    // 沒有成分的基金不能算可投資。
    const open = fund.holdings.length > 0 && missing.length === 0;
    return [fund.slug, { status: open ? 'open' : 'preview', missing }];
  }),
);

/**
 * 這檔展示基金的上線狀態。
 * 不是目錄裡的展示基金（例如 Community 策略 `/funds/strategy/:id`）回 null：那些是真的上鏈的策略，不套這個標示。
 */
export function fundLaunchStatus(slug: string | null | undefined): FundLaunchStatus | null {
  return (typeof slug === 'string' && STATUS_BY_SLUG.get(slug)) || null;
}

/** 上線時可投資的展示基金 slug（照目錄順序）。 */
export const INVESTABLE_FUND_SLUGS: readonly string[] = MOCK_FUNDS
  .filter((fund) => STATUS_BY_SLUG.get(fund.slug)?.status === 'open')
  .map((fund) => fund.slug);

/**
 * 基金頁上的一句說明。`label` 把鏈上符號換成給人看的代號（`NVDAB` → `NVDA`）。
 * 缺的成分最多列三個，其餘用「and N more」帶過：有的基金缺十幾個，全列出來沒有人會讀。
 */
export function describeFundLaunch(launch: FundLaunchStatus, label: (symbol: string) => string = (symbol) => symbol): string {
  if (launch.status === 'open') return LAUNCH_COPY.fundOpenLong;
  const count = launch.missing.length;
  if (count === 0) return LAUNCH_COPY.fundPreviewLong;
  const shown = launch.missing.slice(0, 3).map(label).join(', ');
  const rest = count > 3 ? ` and ${count - 3} more` : '';
  return `${LAUNCH_COPY.fundPreviewLong} ${count === 1 ? 'One of its assets' : `${count} of its assets`} (${shown}${rest}) ${count === 1 ? 'is' : 'are'} not available at launch.`;
}
