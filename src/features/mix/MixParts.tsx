/**
 * My mix 各頁共用的小元件（cre8-app#132）。
 */
import { Fragment, type ReactNode } from 'react';
import { AssetLogo } from '../../components/AssetLogo';
import { OPEN_WALLET_MENU } from '../../components/WalletMenu';
import { useConnectedSessionToken } from '../../lib/use-connected-session';
import { mixAsset, mixAssetByAddress } from './mix-catalog';
import { formatPctString, weightLabel } from './mix-math';
import type { MixAsset } from './mix-types';

/** 純圓形的 logo 本身，不加外框或底色（使用者 2026-11-21）；沒有圖的（例如 Anthropic）才顯示代號第一個字。 */
export function MixLogo({ symbol, size = 36 }: { symbol: string; size?: number }): ReactNode {
  const ticker = mixAsset(symbol)?.ticker ?? symbol;
  return (
    <span className="mx-logo" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      <span>{ticker.slice(0, 1)}</span>
      <AssetLogo symbol={symbol === 'XAUt' ? 'XAUT' : symbol} />
    </span>
  );
}

/** 一排重疊的小 logo（列表、分享卡用）。 */
export function MixLogos({ assets, size = 26 }: { assets: readonly MixAsset[]; size?: number }): ReactNode {
  return (
    <span className="mx-logos">
      {assets.slice(0, 5).map((asset) => {
        const symbol = mixAssetByAddress(asset.assetId)?.symbol ?? '';
        return <MixLogo key={asset.assetId} symbol={symbol} size={size} />;
      })}
      {assets.length > 5 && <span className="mx-logos-more">+{assets.length - 5}</span>}
    </span>
  );
}

const SHADES = ['#14151A', '#FCD535', '#6B6F78', '#C9CCD2', '#3A3D45', '#F0B90B', '#9EA2AA', '#25272E', '#E6E8EB', '#4F535B'];
/** 放在黃色色板上（分享卡）時不用黃色，色段才看得到。 */
const PLATE_SHADES = ['#14151A', '#FFFFFF', '#6B6F78', '#3A3D45', '#B5B8BE', '#25272E', '#8A8E96', '#4F535B', '#E6E8EB', '#9EA2AA'];

/** 成分條：一條依比例切開的色條，下面是代號與比例。 */
export function MixBar({ assets, legend = true, onPlate = false }: { assets: readonly MixAsset[]; legend?: boolean; onPlate?: boolean }): ReactNode {
  const shades = onPlate ? PLATE_SHADES : SHADES;
  return (
    <div className="mx-bar">
      <div className="mx-bar-track" role="img" aria-label={assets.map((a) => `${mixAssetByAddress(a.assetId)?.ticker ?? ''} ${weightLabel(a.weightBps)}`).join(', ')}>
        {assets.map((asset, index) => (
          <span key={asset.assetId} style={{ flexGrow: asset.weightBps, background: shades[index % shades.length] }} />
        ))}
      </div>
      {legend && (
        <ul className="mx-bar-legend">
          {assets.map((asset, index) => (
            <li key={asset.assetId}>
              <i style={{ background: shades[index % shades.length] }} />
              {mixAssetByAddress(asset.assetId)?.ticker}
              <b>{weightLabel(asset.weightBps)}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 「Past year +23%」：只有數字，不放走勢圖（使用者 2026-11-21：要更簡單）。 */
export function PastYear({ y1, loading = false, compact = false }: {
  y1: string | null | undefined;
  loading?: boolean;
  compact?: boolean;
}): ReactNode {
  const label = formatPctString(y1 ?? null);
  const tone = label === null ? '' : label.startsWith('−') ? 'neg' : 'pos';
  return (
    <p className={`mx-past${compact ? ' mx-past--compact' : ''}`}>
      <span>Past year</span>
      <b className={tone}>{loading && label === null ? '…' : label ?? '—'}</b>
    </p>
  );
}

export function useSignedIn(): boolean {
  return useConnectedSessionToken() !== null;
}

/** 要付錢的那一刻才登入：打開登入頁，寫明是為了買什麼。 */
export function askSignIn(subject: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_WALLET_MENU, { detail: { purpose: 'buy', subject } }));
}

/**
 * 組合名稱：數字換成等寬字體（跟金額同一套）。標題用的 Libre Caslon Display 的「0」是圓的，
 * 「0xJoooe 3」會看成「OxJoooe 3」；這個字體沒有別種數字可切（`lining-nums` 畫出來一樣），所以只換數字。
 */
export function MixNameText({ name }: { name: string }): ReactNode {
  return name.split(/(\d+)/).map((part, i) => (i % 2 === 1 ? <span key={i} className="mx-digits">{part}</span> : <Fragment key={i}>{part}</Fragment>));
}
