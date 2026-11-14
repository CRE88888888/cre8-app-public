import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { FEATURES, featureLock } from '../lib/feature-flags';
import type { FeatureKey, FeatureLockInfo } from '../lib/feature-flags';

/**
 * 灰色入口上的小標記：「Mainnet」「Coming soon」「Later」。
 * 沿用全站的 `.badge`（小圓點＋文字，`components/ui.tsx` 的 `Badge` 同一個樣式），不另外發明一種標籤。
 */
export function FeatureBadge({ lock, className }: {
  lock: FeatureLockInfo;
  /** 所在的頁面有自己的標籤樣式時用它（建立基金頁用它的「BETA」樣式），讓同一排的標籤長得一樣。 */
  className?: string;
}): ReactNode {
  return <span className={className ?? 'badge feature-badge'} data-state={lock.state} title={lock.note}>{lock.label}</span>;
}

/**
 * 一個還不能用的入口（cre8-app#58）：看得到、灰色、點不動。
 *
 * - 沒有 `onClick` 以外的任何行為：不導頁、不送請求。點下去只會在下面攤開那一句說明。
 * - 用 `aria-disabled` 而不是 `disabled`：`disabled` 的按鈕收不到點擊與鍵盤焦點，
 *   手機上（沒有滑過）就看不到說明，螢幕報讀器也讀不到它為什麼不能用。
 * - 滑過時瀏覽器會顯示 `title`；點擊或按 Enter 會把說明留在畫面上。
 *
 * 開關是 `on` 時回傳 `children`（真正的入口）；還沒有真正的入口就不要傳，會顯示成一般的可用列。
 */
export function LockedFeature({ feature, icon, description, children }: {
  feature: FeatureKey;
  icon?: ReactNode;
  /** 名稱下面那一行短說明（選填）。完整說明在點擊後出現。 */
  description?: string;
  /** 開關打開後要顯示的真正入口。 */
  children?: ReactNode;
}): ReactNode {
  const lock = featureLock(feature);
  const noteId = useId();
  const [shown, setShown] = useState(false);
  if (lock === null) {
    // 開關打開了：有真正的入口就用它；還沒接上就顯示成一般的列（不是按鈕，因為沒有東西可以按）。
    return children ?? (
      <div className="feature-locked" data-state="on">
        <div className="feature-locked__row">
          <span className="feature-locked__text">
            <b>{FEATURES[feature].name}</b>
            {description !== undefined && <small>{description}</small>}
          </span>
          {icon !== undefined && <span className="feature-locked__icon" aria-hidden="true">{icon}</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="feature-locked" data-state={lock.state}>
      <button
        type="button"
        className="feature-locked__row"
        aria-disabled="true"
        aria-describedby={noteId}
        aria-expanded={shown}
        title={lock.note}
        data-feature={feature}
        onClick={() => setShown((current) => !current)}
      >
        {/* 版面跟入金方式的卡片一樣：名稱與標記在第一行，說明在下面，圖示靠右。 */}
        <span className="feature-locked__text">
          <span className="feature-locked__title"><b>{lock.name}</b><FeatureBadge lock={lock} /></span>
          {description !== undefined && <small>{description}</small>}
        </span>
        {icon !== undefined && <span className="feature-locked__icon" aria-hidden="true">{icon}</span>}
      </button>
      {/* 一直在 DOM 裡（報讀器讀得到按鈕為什麼不能用），點了才顯示。 */}
      <p id={noteId} className="feature-locked__note" role="status" hidden={!shown}>{lock.note}</p>
    </div>
  );
}
