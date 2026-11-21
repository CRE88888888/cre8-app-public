/**
 * Share（cre8-app#132）：一顆按鈕產生連結＋圖卡（名稱、成分、Past year %，不顯示金額），能直接分享到 X、Telegram。
 * 圖卡目前是畫面上的預覽；X／Telegram 連結預覽要的 og:image 由分享頁的伺服器端產生（接 API 時再做）。
 */
import { useState, type ReactNode } from 'react';
import { AppBottomSheet } from '../../components/AppBottomSheet';
import { formatPctString } from './mix-math';
import { MixBar } from './MixParts';
import type { MixAsset } from './mix-types';

export function shareUrl(code: string, origin: string = window.location.origin): string {
  return `${origin}/m/${encodeURIComponent(code)}`;
}

export function ShareSheet({ open, onOpenChange, name, assets, shareCode, y1 }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  assets: MixAsset[];
  shareCode: string;
  y1: string | null;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const url = shareUrl(shareCode);
  const past = formatPctString(y1);
  const text = past === null ? `My mix on CRE8: ${name}` : `My mix on CRE8: ${name}. Past year ${past}.`;
  return (
    <AppBottomSheet open={open} onOpenChange={(next) => { setCopied(false); onOpenChange(next); }} title="Share your mix">
      <figure className="mx-sharecard" aria-label="Share card preview">
        <span className="mx-sharecard-brand">CRE8</span>
        <b className="mx-sharecard-name">{name}</b>
        <MixBar assets={assets} onPlate />
        {past !== null && <p className="mx-sharecard-past"><span>Past year</span><b>{past}</b></p>}
      </figure>
      <div className="mx-share-links">
        <a className="btn mx-cta" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">Post on X</a>
        <a className="btn ghost" href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">Send on Telegram</a>
        <button type="button" className="btn ghost" onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => setCopied(false));
        }}>{copied ? 'Link copied' : 'Copy link'}</button>
      </div>
    </AppBottomSheet>
  );
}
