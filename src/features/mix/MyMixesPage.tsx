/**
 * My mix 分頁（cre8-app#132）：自己的組合，卡片照 Funds 列表（黃色色板、襯線名稱、左下報酬），卡片不放小字。
 * 挑和看都不用登入，所以沒登入或還沒有組合時直接給「Build your mix」。
 */
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppIcon } from '../../components/AppIcon';
import { useBodyClass } from '../../lib/use-body-class';
import { formatReturnBps, formatUsdt } from './mix-math';
import { useMixDraft } from './mix-draft';
import { useMixes } from './mix-api';
import { MixLogos, useSignedIn } from './MixParts';
import { valuedLabel } from './MixPage';
import type { MixDetail } from './mix-types';

export function MyMixesPage(): ReactNode {
  useBodyClass('mix-page');
  const signedIn = useSignedIn();
  const mixes = useMixes();
  const navigate = useNavigate();
  const start = () => {
    useMixDraft.getState().reset();
    navigate('/mix/new');
  };
  const rows = mixes.data?.mixes ?? [];
  const empty = !signedIn || (mixes.isSuccess && rows.length === 0);
  // 列表只讀後端最近一次估值快照（不即時算）：標出最舊那一筆的時間，卡片上不放小字。
  const valuedAt = rows.map((mix) => mix.valuedAt).filter((at): at is string => at !== null).sort()[0];

  return (
    <main className="explore-wrap mx-wrap mx-wrap--list">
      <h1 className="mx-title">My mix</h1>
      {valuedAt !== undefined && <p className="mx-note mx-asof">Values as of {valuedLabel(valuedAt)}</p>}

      {empty && (
        <section className="mx-start">
          <div className="mx-start-art" aria-hidden="true" />
          <h2>Pick a few. We keep the mix.</h2>
          <button type="button" className="btn mx-cta" onClick={start}>Build your mix</button>
        </section>
      )}

      {signedIn && mixes.isPending && <p className="mx-empty" role="status">Loading…</p>}
      {signedIn && mixes.isError && (
        <p className="mx-empty" role="alert">
          Could not load. <button type="button" className="mx-link" onClick={() => void mixes.refetch()}>Try again</button>
        </p>
      )}

      {rows.length > 0 && (
        <ol className="mx-tiles" role="list">
          {rows.map((mix) => <MixTile key={mix.id} mix={mix} />)}
          <li>
            <button type="button" className="mx-tile mx-tile--new" onClick={start}>
              <AppIcon name="create" size={28} />
              <span>New mix</span>
            </button>
          </li>
        </ol>
      )}
    </main>
  );
}

function MixTile({ mix }: { mix: MixDetail }): ReactNode {
  const pct = formatReturnBps(mix.returnBps);
  const tone = pct === null || pct === '0%' ? '' : pct.startsWith('−') ? 'neg' : 'pos';
  return (
    <li>
      <Link to={`/mixes/${mix.id}`} className="mx-tile" data-status={mix.status}>
        <h3>{mix.name}</h3>
        <MixLogos assets={mix.assets} size={30} />
        <p className="mx-tile-foot">
          <b className={tone}>{pct ?? '—'}</b>
          <span>{mix.status === 'exited' ? 'Sold' : mix.currentValueRaw === null ? '—' : `${formatUsdt(mix.currentValueRaw)} USDT`}</span>
        </p>
      </Link>
    </li>
  );
}
