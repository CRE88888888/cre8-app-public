/**
 * 設計器「Download design」的匯出檔，套上這個 app 的鏈與費用（cre8-app#93）。
 *
 * `fundDesign`（`src/reference`，不改）寫死 `chainId: 56`、主網地址、舊的費用欄位。這裡在匯出前改成：
 *   - `chainId`：目前這個 build 的鏈（測試網是 97）。
 *   - 每個資產的 `token` 與現金的地址：測試網用地址簿上的測試網地址（與啟用時送給後端的映射同一份，`testnet-catalogue`）。
 *   - 費用：參數總表的換幣費與績效費分潤（`lib/fees.ts`），拿掉舊的 `platformFeeBps`／`depositFeeBps`。
 */
import { designFeeTerms } from './fees';
import { testnetToken } from './testnet-catalogue';

const MAINNET_USDT = '0x55d398326f99059ff775485246999027b3197955';

type DesignAsset = { symbol?: unknown; token?: unknown; [key: string]: unknown };
type Design = { chainId?: unknown; assets?: unknown; cash?: unknown; [key: string]: unknown };

export function exportDesign<T extends Design>(
  design: T,
  options: { chainId: number; testnet: boolean; feePct: number },
): Omit<T, 'platformFeeBps' | 'depositFeeBps'> & ReturnType<typeof designFeeTerms> & { chainId: number } {
  const tokenFor = (symbol: unknown, mainnet: unknown): unknown =>
    options.testnet && typeof symbol === 'string' ? (testnetToken(symbol) ?? mainnet) : mainnet;
  const { platformFeeBps: _platform, depositFeeBps: _deposit, ...rest } = design as T & { platformFeeBps?: unknown; depositFeeBps?: unknown };
  const assets = Array.isArray(design.assets)
    ? (design.assets as DesignAsset[]).map((asset) => ({ ...asset, token: tokenFor(asset.symbol, asset.token) }))
    : design.assets;
  const cash = design.cash !== null && typeof design.cash === 'object'
    ? { ...(design.cash as Record<string, unknown>), address: tokenFor('USDT', MAINNET_USDT) }
    : design.cash;
  return {
    ...(rest as Omit<T, 'platformFeeBps' | 'depositFeeBps'>),
    chainId: options.chainId,
    ...designFeeTerms(options.feePct),
    assets,
    cash,
  } as Omit<T, 'platformFeeBps' | 'depositFeeBps'> & ReturnType<typeof designFeeTerms> & { chainId: number };
}
