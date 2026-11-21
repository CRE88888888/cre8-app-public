/**
 * 分享頁 `/m/:code`（cre8-app#132）：從 X／Telegram 點進來的人只想「買一樣的」。
 * 不用登入就看得到成分、Past year、幾個人有；Get this mix 直接帶到「名稱＋金額＋Buy」那一頁，
 * 成分已填好，按 Buy 才登入。不顯示金額。
 */
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useBodyClass } from '../../lib/use-body-class';
import { mixAssetByAddress } from './mix-catalog';
import { mixErrorText } from './mix-copy';
import { mixApi, retryMixQuery } from './mix-api';
import { useMixDraft } from './mix-draft';
import { MixBar, MixLogos, PastYear } from './MixParts';
import type { SharedMix } from './mix-types';

export function SharedMixPage(): ReactNode {
  useBodyClass('mix-page');
  const { code = '' } = useParams<{ code: string }>();
  const shared = useQuery({ queryKey: ['mix-shared', code], queryFn: () => mixApi.shared(code), retry: retryMixQuery });
  const navigate = useNavigate();

  if (shared.isPending) return <main className="explore-wrap mx-wrap"><p className="mx-empty" role="status">Loading…</p></main>;
  if (shared.isError) {
    return (
      <main className="explore-wrap mx-wrap">
        <p className="mx-empty">{mixErrorText(shared.error)}</p>
        <button type="button" className="btn mx-cta" onClick={() => navigate('/mix/new')}>Build your own</button>
      </main>
    );
  }
  const mix = shared.data;
  return (
    <main className="explore-wrap mx-wrap mx-wrap--shared">
      <MixLogos assets={mix.assets} size={34} />
      <h1 className="mx-title">{mix.name}</h1>
      {mix.copies > 0 && <p className="mx-note">{mix.copies.toLocaleString('en-US')} {mix.copies === 1 ? 'person has' : 'people have'} this</p>}
      <PastYear y1={mix.modelReturns?.y1} />
      <section className="mx-sec"><MixBar assets={mix.assets} /></section>
      <div className="mx-dock">
        <div className="mx-dock-in mx-dock-in--stack">
          <button type="button" className="btn mx-cta" onClick={() => { startCopy(code, mix); navigate('/mix/new/buy'); }}>Get this mix</button>
        </div>
      </div>
    </main>
  );
}

/** 把分享的組合放進草稿：成分、比例、頻率、Exit 照抄，名稱照原本的，用戶只要填金額。 */
export function startCopy(code: string, mix: SharedMix): void {
  const symbols = mix.assets.map((a) => mixAssetByAddress(a.assetId)?.symbol).filter((s): s is string => s !== undefined);
  useMixDraft.getState().reset({
    symbols,
    weights: mix.assets.map((a) => a.weightBps),
    name: mix.name,
    frequency: mix.rebalance.frequency,
    upBps: mix.exit.takeProfitBps,
    downBps: mix.exit.stopLossBps,
    importCode: code,
    sourceName: mix.name,
  });
}
