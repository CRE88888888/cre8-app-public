import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { Badge, ErrorNote, Note } from '../../components/ui';
import { toast } from '../../components/Toast';
import { SimulatedRate, YieldTag } from '../../components/YieldTag';
import { getPortfolioExecution, getYieldMarkets, postYieldConsent, postYieldExit, postYieldRevoke } from '../../lib/api';
import { CHAIN, lookupUserOperation, sendSudoCalls } from '../../lib/kernel';
import type { RenewalWallet } from '../../lib/kernel';
import { useYieldMarkets, yieldMarketsKey } from '../../lib/use-yield-markets';
import {
  CANCELLED_LENT_LABEL,
  STATE_LABEL,
  cancelledButLent,
  checkYieldRows,
  consentable,
  exitDoneMessage,
  exitInProgress,
  parsePortfolioYield,
  pendingReasonText,
  revocable,
  stoppable,
  yieldRefreshMs,
  yieldViewState,
} from '../../lib/yield';
import type { AssetYield, PortfolioYield, YieldMarket, YieldMarketList, YieldViewState } from '../../lib/yield';
import { YieldFlowStopped, notifyWithRetry, resolveSubmitted, runYieldFlow } from '../../lib/yield-flow';
import { yieldBookFor } from '../../lib/yield-book';
import { YIELD_MOCK, mockPortfolioYield } from '../../lib/yield-mock';
import { browserStorage, pendingKey, readPendingRecords, removePendingRecord, savePendingRecord } from '../../lib/yield-pending';
import type { PendingKind, PendingRecord } from '../../lib/yield-pending';

export const yieldKey = (token: string | null, id: number) => ['portfolio-yield', token ?? 'anonymous', id] as const;

/** FundPage 讀一次，生息區塊與 A10 的「需要更新授權」共用。 */
export type PortfolioLending = {
  /** off／loading／error／ready（審查第 7 項）。只有 ready 的資料可以拿來送簽。 */
  view: YieldViewState;
  data: PortfolioYield | null | undefined;
  markets: YieldMarketList | null | undefined;
  error: unknown;
  fetching: boolean;
  /** 重讀市場清單與帳戶狀態（不用快取），回傳最新的兩份；送簽前與「Refresh」用。 */
  reload: () => Promise<{ data: PortfolioYield | null; markets: YieldMarketList | null }>;
};

/**
 * 這個帳戶的生息狀態（`GET /portfolios/:id/execution` 的 `yield`）。這條鏈沒有生息、或基金沒選市場：`off`。
 * 全部領回進行中每 30 秒重讀（審查第 8 項）。
 */
export function usePortfolioYield(
  token: string | null,
  portfolioId: number | undefined,
  holdings: readonly { asset: string; symbol: string }[],
): PortfolioLending {
  const queryClient = useQueryClient();
  const chainHasYield = yieldBookFor(CHAIN.id) !== null;
  const marketsQuery = useYieldMarkets();
  const markets = marketsQuery.data;
  const key = yieldKey(token, portfolioId ?? 0);
  const load = async (): Promise<PortfolioYield | null> => {
    const book = yieldBookFor(CHAIN.id);
    if (book === null) return null;
    const execution = await getPortfolioExecution(token as string, portfolioId as number);
    const parsed = parsePortfolioYield(execution.yield) ?? (YIELD_MOCK ? mockPortfolioYield(holdings) : null);
    // 每一列的資產必須是地址簿裡那個市場的資產，名稱也用地址簿的（複審 F1）；不符就是讀取失敗。
    return parsed === null ? null : checkYieldRows(parsed, book);
  };
  const status = useQuery({
    queryKey: key,
    queryFn: load,
    enabled: chainHasYield && token !== null && portfolioId !== undefined && markets !== undefined && markets !== null,
    staleTime: 30_000,
    refetchInterval: (query) => yieldRefreshMs(query.state.data),
  });
  const view = yieldViewState({
    chainHasYield,
    markets: { data: markets, isError: marketsQuery.isError, isPending: marketsQuery.isPending },
    status: { data: status.data, isError: status.isError, isPending: status.isPending },
  });
  return {
    view,
    data: status.data,
    markets,
    error: marketsQuery.error ?? status.error,
    fetching: status.isFetching,
    reload: async () => {
      const freshMarkets = await queryClient.fetchQuery({
        queryKey: yieldMarketsKey(CHAIN.id),
        queryFn: ({ signal }) => getYieldMarkets(CHAIN.id, signal),
        staleTime: 0,
      });
      if (freshMarkets === null || token === null || portfolioId === undefined) return { data: null, markets: freshMarkets };
      const fresh = await queryClient.fetchQuery({ queryKey: key, queryFn: load, staleTime: 0 });
      return { data: fresh, markets: freshMarkets };
    },
  };
}

const POST: Record<PendingKind, typeof postYieldConsent> = { consent: postYieldConsent, revoke: postYieldRevoke, exit: postYieldExit };
const KIND_NAME: Record<PendingKind, string> = { consent: 'Turning on lending', revoke: 'Cancelling lending consent', exit: 'Stopping lending' };

/**
 * My position 的「Lending」區塊（APP-3，cre8-app#81）。
 *
 * - 每個有選市場的資產：市場與 APR（模擬市場標「模擬利率」）、狀態、收據債權估值、待領回金額與原因、資料時間。
 * - 同意勾選（暫定，待使用者確認）：不勾的部位不存、維持持有。勾了之後 owner 簽：收據 approve 給 executor ＋
 *   `setYieldPolicy(marketId, max, true)`（不另設每日上限，理由見 `CONSENT_DAILY_ASSETS`）。每次最多 16 個市場，逐批簽、逐批通知。
 * - 「取消同意」（backend#103）：owner 簽 `setYieldPolicy(marketId, 0, false)`。只停新存入，已存的不領回、照樣估值。
 * - 「停止生息並全部領回」（暫定）：owner 簽 `requestExit`，後端再用 session 的 exit 路徑領回；領不出的部分持續顯示待領回與原因。
 *   這是整個帳戶的退出意圖：還沒全部領回之前，不能重新同意（畫面擋在簽名前）。
 *
 * 只有 chain 97 有生息；送簽前重讀最新狀態、核對地址簿（cre8-app#95 審查）。已上鏈但沒通知到後端的簽名存在這個瀏覽器，
 * 可以只重送原 txHash。讀不到就顯示 unknown 與重試，不送簽。
 */
export function YieldPanel({
  wallet,
  token,
  portfolioId,
  account,
  executor,
  dbStrategyId,
  lending,
  usdtDecimals,
  usdtSymbol,
}: {
  wallet: RenewalWallet | null;
  token: string | null;
  portfolioId: number;
  account: string;
  executor: string | null;
  dbStrategyId: number;
  lending: PortfolioLending;
  usdtDecimals: number;
  usdtSymbol: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [busy, setBusy] = useState<PendingKind | 'record' | 'refresh' | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const [, setPendingTick] = useState(0);
  const storeKey = pendingKey(CHAIN.id, account, portfolioId);
  // 其他分頁寫進來的待辦（例如那邊剛送出一筆）：馬上重畫，這裡就停簽（第三輪複審 R2）。
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === storeKey) setPendingTick((tick) => tick + 1);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storeKey]);

  if (yieldBookFor(CHAIN.id) === null) return null;
  const view = lending.view;
  if (view === 'off') return null;
  const storage = browserStorage();
  const unrecorded = readPendingRecords(storage, storeKey);

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: yieldKey(token, portfolioId) });
  }

  async function reload(): Promise<void> {
    setBusy('refresh');
    setError(null);
    try {
      await lending.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  const store = {
    save: (item: PendingRecord) => {
      savePendingRecord(storage, storeKey, item);
      setPendingTick((tick) => tick + 1);
    },
    remove: (userOpHash: string) => {
      removePendingRecord(storage, storeKey, userOpHash);
      setPendingTick((tick) => tick + 1);
    },
  };

  /** 已上鏈、還沒通知到的：只重送原 txHash（審查第 5 項）。 */
  async function resend(item: PendingRecord): Promise<void> {
    if (token === null || item.txHash === null) return;
    setBusy('record');
    setError(null);
    try {
      await POST[item.kind](token, portfolioId, { markets: item.markets, txHash: item.txHash });
      store.remove(item.userOpHash);
      setDone(`Recorded ${item.txHash}.`);
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  /** 已送出、結果不明的：用原 userOpHash 對帳（複審 F5）。 */
  async function check(item: PendingRecord): Promise<void> {
    if (token === null) return;
    setBusy('record');
    setError(null);
    try {
      const outcome = resolveSubmitted(item, await lookupUserOperation(token, item.userOpHash as `0x${string}`));
      if (outcome.action === 'wait') {
        setDone('Not confirmed yet. Check again in a minute; do not sign it again.');
      } else if (outcome.action === 'drop') {
        store.remove(item.userOpHash);
        setDone('That transaction reverted on-chain, so nothing changed. You can sign again.');
        await refresh();
      } else {
        store.save(outcome.record);
        await notifyWithRetry((body) => POST[item.kind](token, portfolioId, body).then(() => undefined), {
          markets: outcome.record.markets,
          txHash: outcome.record.txHash as string,
        });
        store.remove(item.userOpHash);
        setDone(`Confirmed and recorded ${outcome.record.txHash}.`);
        await refresh();
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  if (view !== 'ready') {
    return (
      <section className="panel pros-sec" id="lending">
        <div className="panel-h">
          <h3>Lending</h3>
          {view === 'error' && (
            <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => void reload()}>Retry</button>
          )}
        </div>
        <div className="panel-b">
          {view === 'error' ? (
            <>
              <Note tone="warn">
                Lending status could not be read, so what is lent and its value are unknown, and nothing can be signed here
                until it loads.
              </Note>
              <ErrorNote error={lending.error} />
            </>
          ) : (
            <p className="fine muted" style={{ margin: 0 }}>Loading lending status…</p>
          )}
          <Unrecorded items={unrecorded} busy={busy !== null} onResend={(item) => void resend(item)} onCheck={(item) => void check(item)} />
          <Outcome done={done} progress={progress} />
          <ErrorNote error={error} />
        </div>
      </section>
    );
  }

  const data = lending.data as PortfolioYield;
  const list = lending.markets as YieldMarketList;
  const marketOf = (row: AssetYield): YieldMarket | undefined => list.markets.find((market) => market.id === row.market);
  const canConsent = consentable(data.assets, list.markets);
  const toStop = stoppable(data.assets);
  const canRevoke = revocable(data.assets);
  const exiting = exitInProgress(data.assets);
  const revokeRow = canRevoke.find((row) => row.market === confirmRevoke) ?? null;
  const chosen = canConsent.filter((row) => checked.has(row.market));
  // 有送出但結果不明的簽名：先對帳，釐清前不能重簽（複審 F5）。
  const unresolved = unrecorded.some((item) => item.state === 'submitted');
  const canSign = wallet !== null && token !== null && executor !== null && !unresolved;
  const anySimulated = data.assets.some((row) => marketOf(row)?.simulated === true);
  const pendingRows = data.assets.filter((row) => row.pending !== null);

  async function send(kind: PendingKind): Promise<void> {
    if (wallet === null || token === null || executor === null || unresolved) return;
    const signer = wallet;
    const session = token;
    setBusy(kind);
    setError(null);
    setDone(null);
    const title = KIND_NAME[kind];
    const id = toast.pending(title, 'Checking the latest lending status…');
    try {
      // 每一批簽名前重讀並驗證那一批（F4）；全部領回一次送（F2）；送出就記 userOpHash、上鏈就記 txHash（F3／F5）。
      const done = await runYieldFlow({
        kind,
        wanted: kind === 'consent' ? chosen.map((row) => row.market) : kind === 'revoke' && revokeRow !== null ? [revokeRow.market] : [],
        chainId: CHAIN.id,
        executor,
        book: yieldBookFor(CHAIN.id),
        reload: lending.reload,
        sign: (calls, onSubmitted) =>
          sendSudoCalls({ wallet: signer, token: session, accountAddress: account as Address, strategyId: dbStrategyId, calls, onSubmitted }),
        notify: async (body) => {
          await POST[kind](session, portfolioId, body);
        },
        store,
        // 每次真正送簽前重讀這個帳戶的待辦（含其他分頁寫的），有 submitted 就停。
        hasUnresolved: () => readPendingRecords(browserStorage(), storeKey).some((item) => item.state === 'submitted'),
        onBatch: (index, total) => {
          setProgress(total > 1 ? `Signature ${index + 1} of ${total}: confirm it in your wallet.` : null);
        },
      });
      const symbols = done.map((row) => row.symbol).join(', ');
      const message =
        kind === 'consent'
          ? `Lending is on for ${symbols}. It starts at the next lending window.`
          : kind === 'revoke'
            ? `Lending consent is cancelled for ${symbols}. Nothing new is lent; what is already lent stays lent until you withdraw it.`
            : exitDoneMessage(pendingRows.length);
      setDone(message);
      setChecked(new Set());
      setConfirmStop(false);
      setConfirmRevoke(null);
      toast.replace(id, { tone: 'ok', title: message.split('.')[0] ?? title });
    } catch (stopped) {
      const cause = stopped instanceof YieldFlowStopped ? stopped.cause : stopped;
      setError(cause);
      if (stopped instanceof YieldFlowStopped) {
        const names = (rows: AssetYield[]) => rows.map((row) => row.symbol).join(', ');
        const parts = [
          stopped.done.length > 0 ? `Signed: ${names(stopped.done)}.` : '',
          stopped.submitted.length > 0 ? `Sent, waiting for confirmation: ${names(stopped.submitted)} (check it below before signing again).` : '',
          stopped.done.length + stopped.submitted.length > 0 && stopped.notSent.length > 0 ? `Not sent yet: ${names(stopped.notSent)}.` : '',
        ].filter((part) => part !== '');
        if (parts.length > 0) setDone(parts.join(' '));
        if (kind === 'consent') {
          const finished = new Set([...stopped.done, ...stopped.submitted].map((row) => row.market));
          setChecked((prev) => new Set([...prev].filter((market) => !finished.has(market))));
        }
      }
      toast.replace(id, { tone: 'bad', title: `${title} did not complete`, body: (cause as Error)?.message?.split('\n')[0]?.slice(0, 140) ?? '' });
    } finally {
      setProgress(null);
      setBusy(null);
      await refresh();
    }
  }

  const money = (raw: string | null): string => (raw === null ? 'unknown' : `${fmt(BigInt(raw), usdtDecimals)} ${usdtSymbol}`);

  return (
    <section className="panel pros-sec" id="lending">
      <div className="panel-h">
        <h3>Lending</h3>
        {anySimulated && <SimulatedRate />}
        <button type="button" className="btn ghost sm" disabled={busy !== null || lending.fetching} onClick={() => void reload()}>Refresh</button>
      </div>
      <div className="panel-b">
        <p className="fine" style={{ marginTop: 0 }}>
          The creator picked a lending market for these assets. Your share is only lent if you agree; otherwise it stays in
          your account as the token. Lending is not guaranteed: a market can pause withdrawals or run short of cash.
        </p>
        {data.permission === 'needs_update' && (
          <Note tone="warn">
            Lending needs a permission update on this account. Update it under <a href="#onchain-enrollment">On-chain enrollment</a> —
            one wallet signature. Until then nothing is lent or withdrawn automatically.
          </Note>
        )}
        <dl className="kv">
          <dt>account value</dt>
          <dd>
            {money(data.accountValue)}
            <div className="fine" style={{ marginTop: 2 }}>Includes what is lent, valued conservatively. Lent money is not spendable cash until it is withdrawn.</div>
          </dd>
        </dl>
        <table className="dk-table" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Lend</th>
              <th>Asset</th>
              <th>Market</th>
              <th>Status</th>
              <th className="num">Lent value</th>
            </tr>
          </thead>
          <tbody>
            {data.assets.map((row) => {
              const market = marketOf(row);
              const selectable = canConsent.includes(row);
              const cancelled = cancelledButLent(row);
              const state = cancelled ? { ...CANCELLED_LENT_LABEL, tone: 'neutral' as const } : STATE_LABEL[row.state];
              return (
                <tr key={row.market}>
                  <td>
                    {selectable ? (
                      <input
                        type="checkbox"
                        aria-label={`Lend my ${row.symbol}`}
                        checked={checked.has(row.market)}
                        disabled={busy !== null}
                        onChange={(event) => {
                          const next = new Set(checked);
                          if (event.target.checked) next.add(row.market);
                          else next.delete(row.market);
                          setChecked(next);
                        }}
                      />
                    ) : row.state === 'not_consented' || row.state === 'stopped' ? (
                      <span
                        className="muted"
                        title={exiting ? 'Withdrawing everything is still in progress.' : 'This market is not taking new deposits right now.'}
                      >
                        —
                      </span>
                    ) : cancelled ? (
                      <span className="muted" title="Consent cancelled.">—</span>
                    ) : (
                      <>
                        <span aria-label="Agreed">✓</span>
                        {canRevoke.includes(row) && (
                          <div>
                            <button
                              type="button"
                              className="btn ghost sm"
                              style={{ marginTop: 4 }}
                              disabled={!canSign || busy !== null}
                              onClick={() => {
                                setConfirmStop(false);
                                setConfirmRevoke(row.market);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="mono"><strong>{row.symbol}</strong></td>
                  <td>{market === undefined ? <span className="muted">{row.market}</span> : <YieldTag market={market} />}</td>
                  <td>
                    <Badge tone={state.tone}>{state.label}</Badge>
                    {state.note !== null && <div className="fine" style={{ marginTop: 4 }}>{state.note}</div>}
                    {row.pending !== null && (
                      <div className="fine" style={{ marginTop: 4 }}>
                        <strong>Waiting to come back: {money(row.pending.value)}.</strong> {pendingReasonText(row.pending.reason)}
                      </div>
                    )}
                    {row.dataAt !== null && <div className="fine muted" style={{ marginTop: 2 }}>as of {timeOf(row.dataAt)}</div>}
                  </td>
                  <td className="num">
                    {row.state === 'not_consented' ? '—' : row.valuationState === 'unknown' ? 'unknown' : money(row.receiptValue)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {canConsent.length > 0 && (
            <button type="button" className="btn sm" disabled={!canSign || busy !== null || chosen.length === 0} onClick={() => void send('consent')}>
              {busy === 'consent' ? 'Turning on…' : chosen.length === 0 ? 'Tick the assets to lend' : `Lend ${chosen.map((row) => row.symbol).join(', ')}`}
            </button>
          )}
          {toStop.length > 0 && !confirmStop && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={!canSign || busy !== null}
              onClick={() => {
                setConfirmRevoke(null);
                setConfirmStop(true);
              }}
            >
              Stop lending and withdraw everything
            </button>
          )}
        </div>
        {canConsent.length > 0 && (
          <p className="fine" style={{ marginTop: 6 }}>
            One wallet signature for up to 16 assets. It lets the fund lend the ticked assets and withdraw them back to this account.
          </p>
        )}
        {exiting && (
          <p className="fine" style={{ marginTop: 6 }}>
            Withdrawing everything is still in progress for this account. This updates every 30 seconds; you can agree to lend
            again once it has finished.
          </p>
        )}
        {revokeRow !== null && (
          <div style={{ marginTop: 10 }}>
            <Note tone="neutral">
              Cancelling consent only stops new lending of {revokeRow.symbol}. What is already lent stays lent and is still
              valued here; nothing is withdrawn. To get it back, use Stop lending and withdraw everything.
            </Note>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => setConfirmRevoke(null)}>Keep consent</button>
              <button type="button" className="btn sm" disabled={!canSign || busy !== null} onClick={() => void send('revoke')}>
                {busy === 'revoke' ? 'Cancelling…' : `Cancel consent for ${revokeRow.symbol}`}
              </button>
            </div>
          </div>
        )}
        {confirmStop && (
          <div style={{ marginTop: 10 }}>
            <Note tone="warn">
              New lending stops on every market for this account, and everything lent ({toStop.map((row) => row.symbol).join(', ')})
              is withdrawn back to it. If a market cannot pay all of it back right now, the rest stays listed as waiting to come back,
              with the reason. You cannot agree to lend again until everything is back.
            </Note>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => setConfirmStop(false)}>Keep lending</button>
              <button type="button" className="btn sm" disabled={!canSign || busy !== null} onClick={() => void send('exit')}>
                {busy === 'exit' ? 'Stopping…' : 'Stop and withdraw'}
              </button>
            </div>
          </div>
        )}
        {unresolved && (
          <p className="fine" style={{ marginTop: 8 }}>Signing is paused until the transaction below is checked.</p>
        )}
        <Unrecorded items={unrecorded} busy={busy !== null} onResend={(item) => void resend(item)} onCheck={(item) => void check(item)} />
        <Outcome done={done} progress={progress} />
        <ErrorNote error={error} />
      </div>
    </section>
  );
}

/**
 * 還沒對完帳的簽名（審查第 5 項、複審 F3／F5）：
 * - 已送出、結果不明：顯示完整 userOpHash，用原 hash 對帳；釐清前不能重簽。
 * - 已上鏈、還沒通知到 CRE8：顯示完整 txHash，只重送原 txHash。
 */
function Unrecorded({
  items,
  busy,
  onResend,
  onCheck,
}: {
  items: readonly PendingRecord[];
  busy: boolean;
  onResend: (item: PendingRecord) => void;
  onCheck: (item: PendingRecord) => void;
}): ReactNode {
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => (
        <div key={item.userOpHash} style={{ marginTop: 10 }}>
          {item.state === 'submitted' ? (
            <Note tone="warn">
              {KIND_NAME[item.kind]} for {item.markets.join(', ')} was sent but is not confirmed yet. Do not sign it again until it is
              checked. UserOp: <span className="mono" style={{ wordBreak: 'break-all' }}>{item.userOpHash}</span>
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn sm" disabled={busy} onClick={() => onCheck(item)}>Check status</button>
              </div>
            </Note>
          ) : (
            <Note tone="warn">
              {KIND_NAME[item.kind]} for {item.markets.join(', ')} is done on-chain but CRE8 has not recorded it yet, so nothing is
              lent or withdrawn for it. Transaction: <span className="mono" style={{ wordBreak: 'break-all' }}>{item.txHash}</span>
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn sm" disabled={busy} onClick={() => onResend(item)}>Send the record again</button>
              </div>
            </Note>
          )}
        </div>
      ))}
    </>
  );
}

/** 進度與結果（含 Check status 的結果）：讀取中、讀取失敗的畫面也要顯示（第三輪複審 R5）。 */
function Outcome({ done, progress }: { done: string | null; progress: string | null }): ReactNode {
  return (
    <>
      {progress === null ? null : <p className="fine" role="status" style={{ marginTop: 8 }}>{progress}</p>}
      {done === null ? null : <p className="fine pos" role="status" style={{ marginTop: 8 }}>{done}</p>}
    </>
  );
}

function fmt(value: bigint, decimals: number): string {
  return Number(formatUnits(value, decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
