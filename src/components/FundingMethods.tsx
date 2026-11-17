import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from './AppIcon';
import { LockedFeature } from './FeatureLock';
import { CHAIN } from '../lib/kernel';

/**
 * 「怎麼把錢放進來」的清單（cre8-app#58）。
 *
 * 現在真的能用的只有一種：用自己錢包裡的 USDT 買基金。主網會有的刷卡／Apple Pay（MoonPay）與
 * 其他鏈轉入先放在畫面上，灰色、標「Mainnet」、點不動（`lib/feature-flags.ts` 的
 * `depositCard`、`depositCrossChain`）。
 *
 * 測試網第一批的「領測試 USDT」與「交易所提幣地址」屬於現金帳戶那一批，做好後加在這個清單最前面。
 * 這個元件不送任何請求。
 *
 * 測試網的「Test USDT」卡片點了會帶到基金列表（使用者 2026-11-17：原本只是說明、點不動，看起來像壞了）。
 * 測試 USDT 只能領進已加入的基金帳戶（後端 `POST /faucet/usdt`），所以領取仍在基金頁的 Buy 上。
 */
export function FundingMethods({ variant }: {
  /** `ticket`＝基金頁 Buy 表單下方（有標題與分隔線）；`sheet`＝Add money 面板裡（面板自己有標題）。 */
  variant: 'ticket' | 'sheet';
}): ReactNode {
  return (
    <section className={`funding-methods funding-methods--${variant}`} aria-label="Ways to add money">
      {variant === 'ticket' && <h3 className="funding-methods__title">Ways to add money</h3>}
      {CHAIN.faucetFunded ? variant === 'ticket' ? null : (
        // 測試網：錢由水龍頭直接打進基金帳戶，領取就在基金頁的 Buy 按鈕上（cre8-app#62）。
        // 這裡不放第二顆領取按鈕，整張卡片帶到基金列表，選一檔按 Buy 就會領；也不列「從錢包轉 USDT」，測試網不走那條路。
        // 基金頁（ticket）上面就是那顆按鈕與同一句說明，所以不重複。
        <div className="feature-locked" data-state="on" data-entry="faucet">
          <Link className="feature-locked__row feature-locked__row--link" to="/vaults">
            <span className="feature-locked__text">
              <span className="feature-locked__title"><b>Test USDT</b><span className="badge badge--ok feature-badge">Free</span></span>
              <small>Testnet only. Pick a fund and press Buy: your first purchase comes with 10,000 test USDT, once per person; then claim 1,000 a day. No value.</small>
            </span>
            <span className="feature-locked__icon" aria-hidden="true"><AppIcon name="right" size={22} /></span>
          </Link>
        </div>
      ) : (
        <div className="feature-locked" data-state="on">
          <div className="feature-locked__row">
            <span className="feature-locked__text">
              <span className="feature-locked__title"><b>USDT from your wallet</b><span className="badge badge--ok feature-badge">Available</span></span>
              <small>On BNB Chain. Choose a fund and press Buy.</small>
            </span>
            <span className="feature-locked__icon" aria-hidden="true"><AppIcon name="wallet" size={22} /></span>
          </div>
        </div>
      )}
      <LockedFeature feature="depositCard" icon={<AppIcon name="deposit" size={22} />} description="Visa, Mastercard or Apple Pay" />
      <LockedFeature feature="depositCrossChain" icon={<AppIcon name="network" size={22} />} description="USDC or USDT on other networks" />
    </section>
  );
}
