import type { ReactNode } from 'react';
import { AppIcon } from './AppIcon';
import { LockedFeature } from './FeatureLock';

/**
 * 「怎麼把錢放進來」的清單（cre8-app#58）。
 *
 * 現在真的能用的只有一種：用自己錢包裡的 USDT 買基金。主網會有的刷卡／Apple Pay（MoonPay）與
 * 其他鏈轉入先放在畫面上，灰色、標「Mainnet」、點不動（`lib/feature-flags.ts` 的
 * `depositCard`、`depositCrossChain`）。
 *
 * 測試網第一批的「領測試 USDT」與「交易所提幣地址」屬於現金帳戶那一批，做好後加在這個清單最前面。
 * 這個元件不送任何請求。
 */
export function FundingMethods({ compact = false }: { compact?: boolean }): ReactNode {
  return (
    <section className={compact ? 'funding-methods funding-methods--compact' : 'funding-methods'} aria-label="Ways to add money">
      <h3 className="funding-methods__title">Ways to add money</h3>
      <div className="feature-locked" data-state="on">
        <div className="feature-locked__row">
          <span className="feature-locked__text">
            <span className="feature-locked__title"><b>USDT from your wallet</b><span className="badge badge--ok feature-badge">Available</span></span>
            <small>On BNB Chain. Choose a fund and press Buy.</small>
          </span>
          <span className="feature-locked__icon" aria-hidden="true"><AppIcon name="wallet" size={22} /></span>
        </div>
      </div>
      <LockedFeature feature="depositCard" icon={<AppIcon name="deposit" size={22} />} description="Visa, Mastercard or Apple Pay" />
      <LockedFeature feature="depositCrossChain" icon={<AppIcon name="network" size={22} />} description="USDC or USDT on other networks" />
    </section>
  );
}
