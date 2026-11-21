/**
 * 建立 My mix（cre8-app#132）：只有兩頁，挑 → 名稱＋金額＋Buy。
 *
 * 使用者 2026-11-21 看完第一版：「他們可以取名」「有點醜、不夠簡單」。所以：
 * - 第二頁最上面的大標題就是名稱，點了直接改，預設帶自動名。
 * - 沒有進度條、沒有 Review 頁、沒有確認彈窗：Buy 本身就是確認；要登入就跳整頁登入頁。
 * - 比例預設平均，只顯示 %；點 % 或 Adjust 才出現 −／＋。Auto-balance 與 Exit 收在一列 Options。
 * - 不放說明句：最低金額只在不夠時當按鈕上的字，休市只在真的休市時出現一行。
 * 同一頁也用在 Change mix（`editingId`）與分享連結的 Get this mix（`importCode`）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AppIcon } from '../../components/AppIcon';
import { useBodyClass } from '../../lib/use-body-class';
import { IS_TESTNET } from '../../lib/testnet-catalogue';
import { useConnectedSessionToken } from '../../lib/use-connected-session';
import { useOwnerWallet } from '../../lib/use-owner-wallet';
import { MIX_CATALOG, MIX_GROUPS, POPULAR, mixAsset, searchMixAssets, type MixGroup } from './mix-catalog';
import { FALLBACK_MINIMUM_RAW, MIN_WEIGHT_BPS, TEST_USDT_RAW, defaultMixName, formatUsdt, maxWeight, parseUsdtInput, sameAssets, todayUtc, weightLabel } from './mix-math';
import { FREQUENCY_LABEL, FUNDING_NOT_RECORDED, mixErrorText, marketNote } from './mix-copy';
import { createBody, creationKey, draftAssets, editBody, useMixDraft } from './mix-draft';
import { mixApi, needsSignature, newIdempotencyKey, usePreview } from './mix-api';
import { freshCreationPayload, fundMix, signMix, useWalletUsdt, type MixStage } from './mix-chain';
import { MixLogo, MixLogos, PastYear, askSignIn, useSignedIn } from './MixParts';
import type { Frequency } from './mix-types';

const QUICK_AMOUNTS = [100, 500, 1000];
const UP_CHOICES = [20, 50, 100];
const DOWN_CHOICES = [10, 20, 30];
const FREQUENCIES: Frequency[] = ['daily', 'weekly', 'monthly', 'quarterly'];

export function MixBuilderPage(): ReactNode {
  useBodyClass('mix-page');
  const { step } = useParams<{ step?: string }>();
  const second = step === 'buy';
  const draft = useMixDraft();
  const navigate = useNavigate();

  // 什麼都沒挑就直接開第二頁：回到挑選。
  useEffect(() => {
    if (second && draft.symbols.length === 0) navigate('/mix/new', { replace: true });
  }, [second, draft.symbols.length, navigate]);
  useEffect(() => { window.scrollTo(0, 0); }, [second]);

  const back = second ? '/mix/new' : draft.editingId !== null ? `/mixes/${draft.editingId}` : '/mixes';
  return (
    <main className="explore-wrap mx-wrap" data-step={second ? 'buy' : 'pick'}>
      <Link to={back} className="mx-back" aria-label="Back"><AppIcon name="left" size={22} /></Link>
      {second ? <BuyStep /> : <PickStep />}
    </main>
  );
}

/* ── 1. Pick ─────────────────────────────────────── */

const POPULAR_SET = new Set<string>(POPULAR);
/** 「All」先列熱門，再照目錄順序。 */
const ALL_ORDER = [...POPULAR.map((symbol) => mixAsset(symbol)!), ...MIX_CATALOG.filter((asset) => !POPULAR_SET.has(asset.symbol))];

function PickStep(): ReactNode {
  const draft = useMixDraft();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<MixGroup | 'all'>('all');
  const [full, setFull] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const editing = draft.editingId !== null;

  const toggle = (symbol: string) => {
    const result = draft.toggle(symbol);
    window.clearTimeout(timer.current);
    setFull(result === 'full');
    if (result === 'full') timer.current = window.setTimeout(() => setFull(false), 3500);
  };

  const list = query.trim() !== '' ? searchMixAssets(query, ALL_ORDER) : group === 'all' ? ALL_ORDER : MIX_CATALOG.filter((asset) => asset.group === group);
  const count = draft.symbols.length;

  return (
    <>
      <h1 className="mx-title">{editing ? 'Change your picks' : 'Pick what you want'}</h1>
      <div className="mx-pickbar">
        <label className="explore-search mx-search">
          <AppIcon name="search" size={19} />
          <input type="search" aria-label="Search stocks and crypto" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {query.trim() === '' && (
          <div className="mx-chips app-ticket-presets" role="tablist" aria-label="Category">
            {[{ id: 'all' as const, label: 'All' }, ...MIX_GROUPS].map((g) => (
              <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className="mx-chip" onClick={() => setGroup(g.id)}>{g.label}</button>
            ))}
          </div>
        )}
      </div>

      {list.length === 0 ? <p className="mx-empty">No match for “{query.trim()}”.</p> : (
        <ul className="mx-grid" role="list">
          {list.map((asset) => (
            <li key={asset.symbol}>
              <button type="button" className="mx-card" aria-pressed={draft.symbols.includes(asset.symbol)} onClick={() => toggle(asset.symbol)}>
                <MixLogo symbol={asset.symbol} />
                <b>{asset.ticker}</b>
                {asset.risky && <span className="badge badge--warn mx-risky">Risky</span>}
                <span className="sr-only">{asset.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mx-dock">
        <div className="mx-dock-in">
          <div className="mx-dock-info" role="status">
            {full ? <span className="mx-dock-count">Up to 10. Unpick one first.</span> : count === 0 ? <span className="mx-dock-count mx-muted">Pick up to 10</span> : (
              <><MixLogos assets={draftAssets(draft)} size={26} /><span className="mx-dock-count">{count}</span></>
            )}
          </div>
          <button type="button" className="btn mx-cta" disabled={count === 0} onClick={() => navigate('/mix/new/buy')}>Next</button>
        </div>
      </div>
    </>
  );
}

/* ── 2. 名稱＋金額＋比例＋Buy ───────────────────────── */

function BuyStep(): ReactNode {
  const draft = useMixDraft();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signedIn = useSignedIn();
  const editing = draft.editingId !== null;
  const assets = draftAssets(draft);
  const preview = usePreview(assets);
  const token = useConnectedSessionToken();
  const wallet = useOwnerWallet();
  const balance = useWalletUsdt(signedIn && !editing ? wallet?.address : null);
  const minimum = BigInt(preview.data?.minimumDepositRaw ?? FALLBACK_MINIMUM_RAW);
  const amount = parseUsdtInput(draft.amount);
  const tooLow = !editing && (amount === null || amount < minimum);
  const autoName = defaultMixName(draft.symbols);
  const name = draft.name.trim() || autoName;
  const hasCrypto = draft.symbols.some((symbol) => mixAsset(symbol)?.crypto);
  const closed = preview.data ? marketNote(preview.data.markets, hasCrypto) : null;
  const walletUsdt = balance.data ?? null;
  const short = signedIn && !editing && !tooLow && walletUsdt !== null && amount !== null && walletUsdt < amount;

  const [adjust, setAdjust] = useState(false);
  const [options, setOptions] = useState(false);
  const [stage, setStage] = useState<MixStage | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const single = draft.symbols.length === 1;
  const busy = stage !== null;

  const buy = async (fundWith: 'wallet' | 'test-usdt') => {
    if (!signedIn || token === null) {
      askSignIn(name);
      return;
    }
    if (wallet === null) {
      setError('Your wallet is not ready. Sign in again to continue.');
      return;
    }
    setStage('start');
    setError(null);
    try {
      if (editing) {
        // 只送有改的欄位；只改名稱、頻率、Exit 不用簽，成分或比例變了後端回一組要簽的 calls。
        const id = draft.editingId!;
        const current = await mixApi.get(token, id);
        const result = await mixApi.patch(token, id, editBody(draft, name, !sameAssets(current.assets, assets)));
        if (needsSignature(result)) await signMix({ wallet, token, payload: result, picks: assets, onStage: setStage });
        await refreshMixes(id);
        navigate(`/mixes/${id}?new=1`, { replace: true });
        return;
      }
      // Idempotency-Key 跟草稿一起存在 sessionStorage：重整或登入回來重送，還是同一個組合。
      const body = createBody(draft, name, todayUtc());
      const created = await mixApi.create(token, body, creationKey(body, newIdempotencyKey));
      // 重送時第一次的簽名意圖可能已過期（calls 是空的）：重讀一組；已經確認過就不用再簽。
      const payload = await freshCreationPayload(token, created);
      const signed = payload === null
        ? await mixApi.get(token, created.mixId).then((mix) => ({ mixId: mix.id, account: mix.account, portfolioId: mix.portfolioId }))
        : await signMix({ wallet, token, payload, ...(draft.importCode === null ? { picks: assets } : {}), onStage: setStage });
      draft.set({ creation: null });
      // 組合已經建好：放錢或記帳失敗也帶去組合頁說明；沒記好的入金，組合頁打開時會補記。
      let fundError: string | null = null;
      if (signed.portfolioId === null) {
        fundError = 'Your mix is set up. Add money in a minute, once it shows up here.';
      } else {
        setStage('fund');
        try {
          const funded = await fundMix({
            wallet, token, account: signed.account, mixId: signed.mixId, portfolioId: signed.portfolioId,
            with: fundWith === 'test-usdt' ? { kind: 'test-usdt' } : { kind: 'wallet', amount: amount ?? 0n },
          });
          if (!funded.recorded) fundError = FUNDING_NOT_RECORDED;
        } catch (cause) {
          fundError = `Your mix is set up, but the money did not go in. ${mixErrorText(cause)}`;
        }
      }
      await refreshMixes(signed.mixId);
      // 草稿留到組合頁再清：在這裡清會觸發「沒挑就回第一頁」，把人帶回空白的挑選頁。
      navigate(`/mixes/${signed.mixId}?new=1`, { replace: true, state: fundError === null ? null : { fundError } });
    } catch (e) {
      setError(mixErrorText(e));
      setStage(null);
    }
  };

  const refreshMixes = (id: number) => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['mixes'] }),
    queryClient.invalidateQueries({ queryKey: ['mix', id] }),
    queryClient.invalidateQueries({ queryKey: ['mix-wallet-usdt'] }),
  ]);

  const busyLabel = stage === 'sign' ? 'Confirm in your wallet…' : stage === 'fund' ? 'Adding your USDT…' : stage === 'confirm' ? 'Almost done…' : 'One moment…';

  return (
    <>
      <label className="mx-name">
        <span className="sr-only">Name</span>
        <input value={draft.name} placeholder={autoName} maxLength={100} onChange={(e) => draft.set({ name: e.target.value })} />
        <AppIcon name="edit" size={20} />
      </label>

      {!editing && (
        <section className="mx-sec mx-amount" aria-label="Amount">
          <label className="mx-amount-field" data-low={draft.amount !== '' && tooLow ? 'true' : 'false'}>
            <input inputMode="decimal" autoComplete="off" placeholder="0" aria-label="Amount in USDT" value={draft.amount}
              onChange={(e) => draft.set({ amount: e.target.value.replace(/[^\d.,]/g, '') })} />
            <span>USDT</span>
          </label>
          <div className="mx-chips app-ticket-presets">
            {QUICK_AMOUNTS.map((n) => (
              <button key={n} type="button" className="mx-chip" aria-pressed={amount === BigInt(n) * 10n ** 18n} onClick={() => draft.set({ amount: n.toLocaleString('en-US') })}>
                {n.toLocaleString('en-US')}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="mx-sec" aria-label="Your mix">
        <ul className="mx-weights" role="list">
          {draft.symbols.map((symbol, index) => {
            const asset = mixAsset(symbol);
            const weight = draft.weights[index] ?? 0;
            return (
              <li key={symbol}>
                <MixLogo symbol={symbol} size={32} />
                <b className="mx-weights-ticker">{asset?.ticker}</b>
                {adjust && !single ? (
                  <div className="mx-stepper">
                    <button type="button" aria-label={`Less ${asset?.ticker}`} disabled={weight <= MIN_WEIGHT_BPS}
                      onClick={() => { draft.step(index, -1); draft.set({ importCode: null }); }}>−</button>
                    <output aria-live="polite">{weightLabel(weight)}</output>
                    <button type="button" aria-label={`More ${asset?.ticker}`} disabled={weight >= maxWeight(draft.symbols.length)}
                      onClick={() => { draft.step(index, 1); draft.set({ importCode: null }); }}>+</button>
                  </div>
                ) : (
                  <button type="button" className="mx-pct" disabled={single} onClick={() => setAdjust(true)} aria-label={`${asset?.ticker} ${weightLabel(weight)}, adjust`}>
                    {weightLabel(weight)}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mx-row-links">
          {!single && <button type="button" className="mx-link" onClick={() => setAdjust((on) => !on)}>{adjust ? 'Done' : 'Adjust'}</button>}
          <PastYear compact y1={preview.data?.modelReturns?.y1} loading={preview.isFetching} />
        </div>
      </section>

      <section className="mx-sec">
        <button type="button" className="mx-options" aria-expanded={options} onClick={() => setOptions((on) => !on)}>
          <span>Options</span>
          <b>{FREQUENCY_LABEL[draft.frequency]} · Exit {exitShort(draft.upBps, draft.downBps)}</b>
          <AppIcon name="down" size={18} />
        </button>
        {options && (
          <div className="mx-options-body">
            <p className="mx-label">Auto-balance</p>
            <div className="mx-chips app-ticket-presets">
              {FREQUENCIES.map((f) => (
                <button key={f} type="button" className="mx-chip" aria-pressed={draft.frequency === f} onClick={() => draft.set({ frequency: f })}>{FREQUENCY_LABEL[f]}</button>
              ))}
            </div>
            <label className="mx-label mx-date">Starts
              <input type="date" className="mx-input" min={todayUtc()} value={draft.startDate || todayUtc()} onChange={(e) => draft.set({ startDate: e.target.value })} />
            </label>
            <ExitRow label="Sell all when up" sign="+" choices={UP_CHOICES} value={draft.upBps} onChange={(upBps) => draft.set({ upBps })} />
            <ExitRow label="Sell all when down" sign="−" choices={DOWN_CHOICES} value={draft.downBps} max={99} onChange={(downBps) => draft.set({ downBps })} />
          </div>
        )}
      </section>

      {error && <p className="mx-error" role="alert">{error}</p>}

      <div className="mx-dock">
        <div className="mx-dock-in mx-dock-in--stack">
          {short ? (
            <>
              <p className="mx-dock-note" role="status">You have {formatUsdt(walletUsdt!)} USDT.</p>
              {IS_TESTNET ? (
                <button type="button" className="btn mx-cta" disabled={busy || TEST_USDT_RAW < minimum} onClick={() => void buy('test-usdt')}>
                  {busy ? busyLabel : 'Buy with 1,000 test USDT'}
                </button>
              ) : <button type="button" className="btn mx-cta" disabled>Add USDT first</button>}
            </>
          ) : (
            <>
              {closed && !tooLow && <p className="mx-dock-note">{closed}</p>}
              <button type="button" className="btn mx-cta" disabled={busy || tooLow} onClick={() => void buy('wallet')}>
                {busy ? busyLabel : editing ? 'Save' : tooLow ? `Add at least ${formatUsdt(minimum)} USDT` : 'Buy'}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** 萬分比 → 畫面上的 %（只用來顯示，不再換回 bps）。 */
const pctLabel = (bps: number) => String(bps / 100);

function exitShort(up: number | null, down: number | null): string {
  if (up === null && down === null) return 'off';
  return [up === null ? null : `+${pctLabel(up)}%`, down === null ? null : `−${pctLabel(down)}%`].filter(Boolean).join(' / ');
}

/** `value` 是萬分比整數（和後端同單位）；快選與自訂欄位用整數 %，換成 bps 只乘不除，不會有小數誤差。 */
function ExitRow({ label, sign, choices, value, max = 1000, onChange }: {
  label: string;
  sign: '+' | '−';
  /** 整數 %。 */
  choices: number[];
  value: number | null;
  /** 整數 %。 */
  max?: number;
  onChange: (bps: number | null) => void;
}): ReactNode {
  const own = value !== null && !choices.some((n) => n * 100 === value);
  return (
    <div className="mx-exit">
      <p className="mx-label">{label}</p>
      <div className="mx-chips app-ticket-presets">
        <button type="button" className="mx-chip" aria-pressed={value === null} onClick={() => onChange(null)}>Off</button>
        {choices.map((n) => (
          <button key={n} type="button" className="mx-chip" aria-pressed={value === n * 100} onClick={() => onChange(n * 100)}>{sign}{n}%</button>
        ))}
        <label className="mx-chip mx-exit-own">
          <span aria-hidden="true">{sign}</span>
          <input inputMode="numeric" aria-label={`${label}, percent`} placeholder="__" value={own ? pctLabel(value) : ''}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value.replace(/\D/g, ''), 10);
              onChange(Number.isFinite(n) && n > 0 ? Math.min(n, max) * 100 : null);
            }} />
          <span aria-hidden="true">%</span>
        </label>
      </div>
    </div>
  );
}

/** Change mix：把目前的組合放進草稿，從挑選開始。 */
export function startChange(mix: { id: number; name: string; assets: { assetId: string; weightBps: number }[]; rebalance: { frequency: Frequency; startDate: string }; exit: { takeProfitBps: number | null; stopLossBps: number | null } }): void {
  const symbols = mix.assets.map((a) => MIX_CATALOG.find((c) => c.address === a.assetId.toLowerCase())?.symbol).filter((s): s is string => s !== undefined);
  useMixDraft.getState().reset({
    symbols,
    weights: mix.assets.map((a) => a.weightBps),
    name: mix.name,
    frequency: mix.rebalance.frequency,
    startDate: mix.rebalance.startDate,
    upBps: mix.exit.takeProfitBps,
    downBps: mix.exit.stopLossBps,
    editingId: mix.id,
    base: { name: mix.name, rebalance: mix.rebalance, exit: mix.exit },
  });
}
