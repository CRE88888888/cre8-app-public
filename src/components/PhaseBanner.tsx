import type { ReactNode } from 'react';

/**
 * 「Testnet phase」跑馬燈。原站每一頁頂端都有這一條。
 *
 * 內容是重複的裝飾（`aria-hidden`），真正的語意放在 `aria-label` 與視覺隱藏的 label 上 ——
 * 跑馬燈讓螢幕閱讀器念四遍同樣的字沒有意義。
 */
export function PhaseBanner(): ReactNode {
  return (
    <div className="phase-banner" aria-label="Testnet phase">
      <span className="phase-banner__label">Testnet phase</span>
      <div className="phase-banner__track" aria-hidden="true">
        {[0, 1].map((copy) => (
          <div className="phase-banner__group" key={copy}>
            {[0, 1, 2, 3].map((item) => (
              <span key={item}>
                Testnet phase <i>·</i>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
