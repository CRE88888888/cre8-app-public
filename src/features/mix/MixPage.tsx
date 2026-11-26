/**
 * 單一 My mix（cre8-app#132）。最上面是名稱（點了就能改名）與建立日期，再來價值、賺賠、Add money。
 * 使用者 2026-11-21：「有點醜、不夠簡單」，所以字和線都少；帳戶地址收在 Details。
 *
 * 後端（backend#179）沒有「賣掉／部分領出」的端點：進行中的組合只能 Add money；觸發 Exit 全部換成 USDT 之後，
 * Withdraw 把帳戶裡的 USDT 全部領回錢包（owner 簽、後端代付）。Close mix 等後端有端點再加。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AppIcon } from '../../components/AppIcon';
import { AppBottomSheet } from '../../components/AppBottomSheet';
import { WalletMenu } from '../../components/WalletMenu';
import { useBodyClass } from '../../lib/use-body-class';
import { IS_TESTNET } from '../../lib/testnet-catalogue';
import { useConnectedSessionToken } from '../../lib/use-connected-session';
import { useOwnerWallet } from '../../lib/use-owner-wallet';
import { mixAssetByAddress } from './mix-catalog';
import { FALLBACK_MINIMUM_RAW, TEST_USDT_RAW, addMoneyCheck, formatReturnBps, formatUsdt, parseUsdtInput, shortDate } from './mix-math';
import { FREQUENCY_LABEL, FUNDING_NOT_RECORDED, eventText, exitedText, freshNote, marketNote, mixErrorText } from './mix-copy';
import { mixApi, useMix, usePreview } from './mix-api';
import { fundMix, readMixUsdt, settlePendingMixFunding, signMix, useWalletUsdt, withdrawMixUsdt } from './mix-chain';
import { MixBar, MixNameText, PastYear, useSignedIn } from './MixParts';
import { ShareSheet } from './ShareSheet';
import { startChange } from './MixBuilderPage';
import { useMixDraft } from './mix-draft';
import type { MixDetail } from './mix-types';

export function MixPage(): ReactNode {
  useBodyClass('mix-page');
  const { id } = useParams<{ id: string }>();
  const signedIn = useSignedIn();
  const mix = useMix(Number(id));

  if (!signedIn) {
    return (
      <main className="explore-wrap mx-wrap">
        <BackLink />
        <section className="mx-start mx-start--plain">
          <h2>Sign in to see your mix.</h2>
          <WalletMenu inline />
        </section>
      </main>
    );
  }
  if (mix.isPending) return <main className="explore-wrap mx-wrap"><BackLink /><p className="mx-empty" role="status">Loading…</p></main>;
  if (mix.isError) {
    return (
      <main className="explore-wrap mx-wrap">
        <BackLink />
        <p className="mx-empty" role="alert">{mixErrorText(mix.error)}</p>
      </main>
    );
  }
  return <MixView mix={mix.data} />;
}

function BackLink(): ReactNode {
  return <Link to="/mixes" className="mx-back" aria-label="Back to My mix"><AppIcon name="left" size={22} /></Link>;
}

type SheetKind = 'add' | 'withdraw' | 'share' | null;

function MixView({ mix }: { mix: MixDetail }): ReactNode {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = useConnectedSessionToken();
  const wallet = useOwnerWallet();
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [restarting, setRestarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fundError = (location.state as { fundError?: string } | null)?.fundError ?? null;
  const preview = usePreview(mix.assets);
  const exited = mix.status === 'exited';
  const exiting = mix.status === 'exiting';
  const pct = formatReturnBps(mix.returnBps);
  const tone = pct === null || pct === '0%' ? '' : pct.startsWith('−') ? 'neg' : 'pos';
  const hasCrypto = mix.assets.some((a) => mixAssetByAddress(a.assetId)?.crypto);
  const closed = marketNote(mix.markets, hasCrypto);
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['mix', mix.id] }),
    queryClient.invalidateQueries({ queryKey: ['mixes'] }),
    queryClient.invalidateQueries({ queryKey: ['mix-wallet-usdt'] }),
  ]);
  // 建好或改了成分、還沒簽（例如關掉了分頁）：重讀要簽的那一組，簽完確認。
  const finish = async () => {
    if (token === null || wallet === null) return;
    setFinishing(true);
    setError(null);
    try {
      const payload = await mixApi.prepare(token, mix.id);
      await signMix({ wallet, token, payload });
      await refresh();
    } catch (e) {
      setError(mixErrorText(e));
    } finally {
      setFinishing(false);
    }
  };

  // 上次放進來、還沒記成投入的 USDT：打開組合頁就補記（記好後端才會買）。
  useEffect(() => {
    if (token === null || mix.portfolioId === null) return;
    void settlePendingMixFunding(token, mix.id, mix.portfolioId).then((settled) => { if (settled > 0) void refresh(); });
  }, [token, mix.portfolioId]);

  // 剛買好：一行提示，幾秒後自己消失。
  const fresh = params.get('new') === '1';
  useEffect(() => {
    if (!fresh) return;
    useMixDraft.getState().reset();
    const timer = window.setTimeout(() => { params.delete('new'); setParams(params, { replace: true }); }, 6000);
    return () => window.clearTimeout(timer);
  }, [fresh, params, setParams]);

  return (
    <main className="explore-wrap mx-wrap mx-wrap--detail">
      <BackLink />

      <header className="mx-head">
        <MixName mix={mix} onSaved={refresh} />
        <span className="mx-created">Created {shortDate(mix.createdAt)}</span>
      </header>

      {fresh && fundError === null && <p className="mx-done" role="status"><AppIcon name="check" size={18} />{freshNote(mix.events, mix.pendingChange, closed !== null)}</p>}
      {fundError !== null && <p className="mx-error" role="alert">{fundError}</p>}
      {mix.pendingChange && (
        <div className="mx-actions">
          <p className="mx-note">{mix.status === 'awaiting_enrollment' ? 'One more step to start this mix.' : 'Your new mix needs one more step.'}</p>
          <button type="button" className="btn mx-cta" disabled={finishing || wallet === null} onClick={() => void finish()}>{finishing ? 'Confirm in your wallet…' : 'Finish'}</button>
        </div>
      )}
      {error !== null && <p className="mx-error" role="alert">{error}</p>}

      {exited ? (
        <>
          <p className="mx-exited">{exitedText(mix)}</p>
          <div className="mx-actions">
            <button type="button" className="btn mx-cta" onClick={() => setSheet('withdraw')}>Withdraw</button>
            <button type="button" className="btn ghost" disabled={restarting || token === null} onClick={() => {
              setRestarting(true);
              setError(null);
              void mixApi.restart(token!, mix.id).then(refresh, (e: unknown) => setError(mixErrorText(e))).finally(() => setRestarting(false));
            }}>{restarting ? 'Starting…' : 'Start again'}</button>
          </div>
        </>
      ) : (
        <>
          <p className="mx-value">
            <b>{mix.currentValueRaw === null ? '—' : formatUsdt(mix.currentValueRaw)}</b><span>USDT</span>
            {mix.performanceMessage === null && pct !== null && <em className={tone}>{pct}</em>}
          </p>
          {exiting && <p className="mx-note">Selling everything for USDT.</p>}
          {mix.valuedAt !== null && Date.now() - Date.parse(mix.valuedAt) > STALE_MS && <p className="mx-note">As of {valuedLabel(mix.valuedAt)}</p>}
          <div className="mx-actions">
            <button type="button" className="btn mx-cta" disabled={exiting || mix.portfolioId === null || mix.pendingChange} onClick={() => setSheet('add')}>Add money</button>
          </div>
          {/* 改比例還沒確認：這時放進來的錢後端不收（MIX_SWITCH_PENDING），先停用。 */}
          {mix.pendingChange && mix.status !== 'awaiting_enrollment' && <p className="mx-note">Finishing your change…</p>}
        </>
      )}

      <section className="mx-sec">
        <MixBar assets={mix.assets} />
        <div className="mx-row-links">
          {!exited && (
            <button type="button" className="mx-link" disabled={mix.pendingChange || exiting} onClick={() => { startChange(mix); navigate('/mix/new'); }}>Change mix</button>
          )}
          <button type="button" className="mx-link" onClick={() => setSheet('share')}>Share</button>
          <PastYear compact y1={preview.data?.modelReturns?.y1} />
        </div>
        <p className="mx-note">{optionsLine(mix)}</p>
      </section>

      {mix.events.length > 0 && (
        <section className="mx-sec">
          <h2 className="mx-h2">Recent</h2>
          <ol className="mx-events" role="list">
            {mix.events.slice(0, 3).map((event) => (
              <li key={event.id}><time dateTime={event.at}>{shortDate(event.at)}</time><span>{eventText(event, mix.events)}</span></li>
            ))}
          </ol>
        </section>
      )}

      <details className="mx-details">
        <summary>Details</summary>
        <p className="mx-note mono">{mix.account}</p>
      </details>

      <AddSheet open={sheet === 'add'} mix={mix} minimum={BigInt(preview.data?.minimumDepositRaw ?? FALLBACK_MINIMUM_RAW)} onClose={() => setSheet(null)} onDone={refresh} />
      <WithdrawSheet open={sheet === 'withdraw'} mix={mix} onClose={() => setSheet(null)} onDone={refresh} />
      <ShareSheet open={sheet === 'share'} onOpenChange={(open) => setSheet(open ? 'share' : null)} name={mix.name} assets={mix.assets} shareCode={mix.shareCode} y1={preview.data?.modelReturns?.y1 ?? null} />
    </main>
  );
}

/** 「Every month · next Dec 7 · Exit off」：Auto-balance 與 Exit 一行講完。 */
function optionsLine(mix: MixDetail): string {
  const { takeProfitBps: up, stopLossBps: down } = mix.exit;
  const exit = up === null && down === null ? 'Exit off' : `Exit ${[up === null ? null : `+${up / 100}%`, down === null ? null : `−${down / 100}%`].filter(Boolean).join(' / ')}`;
  if (mix.status === 'exited') return `Auto-balance stopped · ${exit}`;
  return [FREQUENCY_LABEL[mix.rebalance.frequency], mix.nextRebalanceAt ? `next ${shortDate(mix.nextRebalanceAt)}` : null, exit].filter(Boolean).join(' · ');
}

/** 名稱：點了就能改，Enter 或點別處存檔，Esc 取消。 */
function MixName({ mix, onSaved }: { mix: MixDetail; onSaved: () => Promise<unknown> }): ReactNode {
  const token = useConnectedSessionToken();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(mix.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  const save = () => {
    const next = value.trim();
    setEditing(false);
    if (next === '' || next === mix.name || token === null) { setValue(mix.name); return; }
    void mixApi.patch(token, mix.id, { name: next }).then(onSaved, () => setValue(mix.name));
  };
  if (editing) {
    return (
      <label className="mx-name mx-name--edit">
        <span className="sr-only">Name</span>
        <input ref={input} value={value} maxLength={100} onChange={(e) => setValue(e.target.value)} onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setValue(mix.name); setEditing(false); } }} />
      </label>
    );
  }
  return (
    <h1 className="mx-name">
      <button type="button" onClick={() => setEditing(true)} aria-label={`${mix.name}, rename`}>
        <span><MixNameText name={mix.name} /></span><AppIcon name="edit" size={20} />
      </button>
    </h1>
  );
}

/** 明細是即時估值；拿到的是超過 10 分鐘的舊快照（後端忙或 RPC 暫時不通）才說明時間。 */
const STALE_MS = 10 * 60_000;

/** 「Nov 21, 3:20 PM」：估值快照的時間（列表與明細都用）。 */
export function valuedLabel(at: string): string {
  return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Add money：一個金額、一顆按鈕。錢包 USDT 不夠時（測試網）改成把今天的 1,000 測試 USDT 領進來。 */
function AddSheet({ open, mix, minimum, onClose, onDone }: { open: boolean; mix: MixDetail; minimum: bigint; onClose: () => void; onDone: () => Promise<unknown> }): ReactNode {
  const token = useConnectedSessionToken();
  const wallet = useOwnerWallet();
  const balance = useWalletUsdt(open ? wallet?.address : null);
  const [amount, setAmount] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string>('');
  const [note, setNote] = useState<string | null>(null);
  const value = parseUsdtInput(amount);
  const have = balance.data ?? null;
  const short = have !== null && value !== null && value > have;
  const check = addMoneyCheck(value, minimum);
  const close = () => { setAmount(''); setState('idle'); setError(null); onClose(); };
  const run = async (testUsdt: boolean) => {
    if (token === null || wallet === null || mix.portfolioId === null || mix.pendingChange) return;
    // 低於最低入金：不轉（轉了記不成投入，組合會卡住）。
    if (addMoneyCheck(testUsdt ? TEST_USDT_RAW : value, minimum) !== 'ok') {
      setError(`Add at least ${formatUsdt(minimum)} USDT.`);
      return;
    }
    setState('busy');
    setError(null);
    try {
      const funded = await fundMix({
        wallet, token, account: mix.account, mixId: mix.id, portfolioId: mix.portfolioId,
        with: testUsdt ? { kind: 'test-usdt' } : { kind: 'wallet', amount: value ?? 0n },
      });
      setAdded(testUsdt ? '1,000' : formatUsdt(value ?? 0n));
      setNote(funded.recorded ? null : FUNDING_NOT_RECORDED);
      setState('done');
      void onDone();
    } catch (e) {
      setError(mixErrorText(e));
      setState('idle');
    }
  };
  return (
    <AppBottomSheet open={open} onOpenChange={(next) => { if (!next) close(); }} title="Add money" locked={state === 'busy'}>
      {state === 'done' ? (
        <>
          <p className="mx-sheet-text">{note ?? `Added ${added} USDT.`}</p>
          <button type="button" className="btn mx-cta" onClick={close}>OK</button>
        </>
      ) : (
        <>
          <label className="mx-amount-field">
            <input inputMode="decimal" placeholder="0" aria-label="Add money, USDT" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} />
            <span>USDT</span>
          </label>
          {have !== null && <p className="mx-note">You have {formatUsdt(have)} USDT.</p>}
          {check === 'below-minimum' && error === null && <p className="mx-error" role="alert">Add at least {formatUsdt(minimum)} USDT.</p>}
          {error && <p className="mx-error" role="alert">{error}</p>}
          {short && IS_TESTNET ? (
            <button type="button" className="btn mx-cta" disabled={state === 'busy' || addMoneyCheck(TEST_USDT_RAW, minimum) !== 'ok'} onClick={() => void run(true)}>{state === 'busy' ? 'One moment…' : 'Add 1,000 test USDT'}</button>
          ) : (
            <button type="button" className="btn mx-cta" disabled={check !== 'ok' || short || state === 'busy' || wallet === null} onClick={() => void run(false)}>
              {state === 'busy' ? 'Confirm in your wallet…' : 'Add money'}
            </button>
          )}
        </>
      )}
    </AppBottomSheet>
  );
}

/** Withdraw（已全部賣成 USDT 之後）：把帳戶裡的 USDT 全部領回錢包。 */
function WithdrawSheet({ open, mix, onClose, onDone }: { open: boolean; mix: MixDetail; onClose: () => void; onDone: () => Promise<unknown> }): ReactNode {
  const token = useConnectedSessionToken();
  const wallet = useOwnerWallet();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [cash, setCash] = useState<bigint | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void readMixUsdt(mix.account).then((value) => { if (live) setCash(value); });
    return () => { live = false; };
  }, [open, mix.account]);
  const close = () => { setState('idle'); setError(null); onClose(); };
  const withdraw = async () => {
    if (token === null || wallet === null || cash === null || cash === 0n) return;
    setState('busy');
    setError(null);
    try {
      await withdrawMixUsdt({ wallet, token, account: mix.account, strategyId: mix.strategyId, amount: cash });
      setState('done');
      void onDone();
    } catch (e) {
      setError(mixErrorText(e));
      setState('idle');
    }
  };
  return (
    <AppBottomSheet open={open} onOpenChange={(next) => { if (!next) close(); }} title="Withdraw" locked={state === 'busy'}>
      {state === 'done' ? (
        <>
          <p className="mx-sheet-text">{formatUsdt(cash ?? 0n)} USDT is back in your wallet.</p>
          <button type="button" className="btn mx-cta" onClick={close}>OK</button>
        </>
      ) : (
        <>
          <p className="mx-sheet-text">{cash === null ? 'Checking your USDT…' : cash === 0n ? 'There is no USDT in this mix.' : `${formatUsdt(cash)} USDT goes back to your wallet.`}</p>
          {error && <p className="mx-error" role="alert">{error}</p>}
          <button type="button" className="btn mx-cta" disabled={cash === null || cash === 0n || state === 'busy' || wallet === null} onClick={() => void withdraw()}>
            {state === 'busy' ? 'Confirm in your wallet…' : 'Withdraw'}
          </button>
        </>
      )}
    </AppBottomSheet>
  );
}
