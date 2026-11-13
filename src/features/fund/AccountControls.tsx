import { useState } from 'react';
import type { ReactNode } from 'react';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { Badge, ErrorNote, Note } from '../../components/ui';
import { toast } from '../../components/Toast';
import {
  buyAllowanceState,
  buyLimitMessage,
  describePause,
  diffAllocations,
  pauseSourcesFromFlags,
  resumeNeedsWarning,
  PLATFORM_PAUSED_MESSAGE,
} from '../../lib/a10';
import type { PauseSource } from '../../lib/a10';
import { enrollCalldata, setPausedCalldata } from '../../lib/atp-contracts';
import type { OnchainAllocation } from '../../lib/atp-contracts';
import { sendSudoCalls } from '../../lib/kernel';
import type { RenewalWallet } from '../../lib/kernel';
import type { AccountOnchain } from './use-account-onchain';

/**
 * My position 裡的兩個 A10 區塊（cre8-app#29）：
 *
 * 1. **On-chain enrollment** —— 這個帳戶在鏈上實際釘住的策略、版本、資產；provider 發布新版時
 *    列出新舊差異，使用者同意後自己簽一筆把帳戶升上去（後端不再代換）。
 * 2. **Trading** —— 自己暫停／恢復，暫停來源，以及今天的買入額度。
 *
 * 兩個動作都是 owner 簽的 sudo UserOp：`account.execute(registry.enroll(account, id))` 與
 * `account.execute(registry.setPaused(account, bool))`。session key 碰不到 registry，
 * 所以只有帳戶 owner 本人做得到。
 */
export function AccountControls({
  wallet,
  token,
  account,
  dbStrategyId,
  onchain,
  loading,
  backendPauseSources,
  symbolOf,
  usdtDecimals,
  usdtSymbol,
  onChanged,
}: {
  wallet: RenewalWallet | null;
  token: string | null;
  account: string;
  /** 後端的策略 id（算帳戶 salt 用）；跟 registry 上的 id 不一定是同一個數字。 */
  dbStrategyId: number;
  onchain: AccountOnchain | undefined;
  loading: boolean;
  /** 後端 status 回報的暫停來源；鏈上讀不到時的備援。 */
  backendPauseSources: readonly PauseSource[] | null;
  symbolOf: (asset: string) => string;
  usdtDecimals: number;
  usdtSymbol: string;
  /** 送出成功後呼叫：重讀鏈上狀態與後端 status。 */
  onChanged: () => Promise<void>;
}): ReactNode {
  const [busy, setBusy] = useState<'upgrade' | 'pause' | 'resume' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmResume, setConfirmResume] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const state = onchain?.account ?? null;
  const enrolled = state !== null && state.version > 0;
  const paused = state?.paused ?? false;
  const sources: readonly PauseSource[] | null =
    state !== null && state.pauseFlags !== null ? pauseSourcesFromFlags(state.pauseFlags) : backendPauseSources;
  const upgradeTo = enrolled && state.latestVersion > state.version ? state.latestVersion : null;
  const changes = upgradeTo !== null && state?.current && state.latest ? diffAllocations(state.current, state.latest) : [];
  const allowance = onchain?.allowance ?? null;
  const allowanceState = allowance === null ? null : buyAllowanceState(allowance, Math.floor(Date.now() / 1000));
  const canSign = wallet !== null && token !== null && state !== null;

  async function send(kind: 'upgrade' | 'pause' | 'resume'): Promise<void> {
    if (wallet === null || token === null || state === null) return;
    setBusy(kind);
    setError(null);
    setDone(null);
    const title = kind === 'upgrade' ? 'Updating fund version' : kind === 'pause' ? 'Pausing trading' : 'Resuming trading';
    const id = toast.pending(title, 'Confirm it in your wallet…');
    try {
      const data =
        kind === 'upgrade'
          ? enrollCalldata(account as Address, state.strategyId)
          : setPausedCalldata(account as Address, kind === 'pause');
      const receipt = await sendSudoCalls({
        wallet,
        token,
        accountAddress: account as Address,
        strategyId: dbStrategyId,
        calls: [{ to: state.registry, data, value: 0n }],
      });
      if (!receipt.success) throw new Error(`The transaction landed on-chain but reverted: ${receipt.txHash}`);
      const message =
        kind === 'upgrade'
          ? `Updated to version ${state.latestVersion}. The next rebalance moves your holdings to the new weights.`
          : kind === 'pause'
            ? 'Trading is paused for this account.'
            : 'Trading is on again for this account.';
      setDone(message);
      setConfirmResume(false);
      toast.replace(id, { tone: 'ok', title: message.split('.')[0] ?? title, body: receipt.txHash });
      await onChanged();
    } catch (cause) {
      setError(cause);
      toast.replace(id, { tone: 'bad', title: `${title} did not complete`, body: (cause as Error).message.split('\n')[0]?.slice(0, 140) ?? '' });
    } finally {
      setBusy(null);
    }
  }

  const allocationLine = (rows: OnchainAllocation | null): string =>
    rows === null || rows.length === 0
      ? '—'
      : [...rows].sort((a, b) => b.weightBps - a.weightBps).map((row) => `${symbolOf(row.asset)} ${(row.weightBps / 100).toFixed(row.weightBps % 100 === 0 ? 0 : 2)}%`).join(' · ');
  const pct = (bps: number): string => (bps === 0 ? '—' : `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`);

  return (
    <>
      <section className="panel pros-sec" id="onchain-enrollment">
        <div className="panel-h">
          <h3>On-chain enrollment</h3>
          {upgradeTo !== null && <Badge tone="warn">Update available</Badge>}
        </div>
        <div className="panel-b">
          {onchain === undefined ? (
            <p className="fine">{wallet === null ? 'Connect your wallet to read this account from the chain.' : loading ? 'Reading the chain…' : 'Not read yet.'}</p>
          ) : state === null ? (
            <p className="fine">The fund registry could not be read right now. Nothing here is assumed; try again in a moment.</p>
          ) : !enrolled ? (
            <p className="fine">This account is not enrolled in a fund on-chain yet. That happens with your first purchase.</p>
          ) : (
            <>
              <p className="fine" style={{ marginTop: 0 }}>
                What this account is set to follow, read directly from the fund registry contract.
              </p>
              <dl className="kv">
                <dt>fund</dt>
                <dd className="mono">registry #{state.strategyId.toString()}</dd>
                <dt>version</dt>
                <dd>
                  v{state.version}
                  {upgradeTo === null ? ' (latest)' : ` — v${upgradeTo} is available`}
                </dd>
                <dt>assets</dt>
                <dd>{allocationLine(state.current)}</dd>
              </dl>
              {upgradeTo !== null && (
                <div style={{ marginTop: 12 }}>
                  <Note tone="warn">
                    The creator published version {upgradeTo}. Your account stays on version {state.version} until you
                    choose to update — nobody can switch it for you.
                  </Note>
                  <table className="dk-table" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th className="num">Now (v{state.version})</th>
                        <th className="num">New (v{upgradeTo})</th>
                        <th>Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((row) => (
                        <tr key={row.asset}>
                          <td className="mono"><strong>{symbolOf(row.asset)}</strong></td>
                          <td className="num">{pct(row.fromBps)}</td>
                          <td className="num">{pct(row.toBps)}</td>
                          <td>
                            {row.kind === 'added' ? <Badge tone="ok">Added</Badge>
                              : row.kind === 'removed' ? <Badge tone="bad">Removed</Badge>
                              : row.kind === 'changed' ? <Badge tone="warn">{row.toBps > row.fromBps ? 'More' : 'Less'}</Badge>
                              : <span className="muted">Same</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button type="button" className="btn sm" style={{ marginTop: 10 }} disabled={!canSign || busy !== null} onClick={() => void send('upgrade')}>
                    {busy === 'upgrade' ? 'Updating…' : `Update to version ${upgradeTo}`}
                  </button>
                  <p className="fine" style={{ marginTop: 6 }}>
                    One wallet signature. The next rebalance then trades your holdings to the new weights.
                    {paused ? ' Updating also turns trading back on for this account.' : ''}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="panel pros-sec" id="trading-control">
        <div className="panel-h">
          <h3>Trading</h3>
        </div>
        <div className="panel-b">
          {onchain?.globalPaused === true && <Note tone="warn">{PLATFORM_PAUSED_MESSAGE}</Note>}
          <dl className="kv">
            <dt>automated trading</dt>
            <dd>
              {state === null || !enrolled ? (
                <span className="muted">—</span>
              ) : paused ? (
                <>
                  <Badge tone="warn">Paused</Badge>
                  <div className="fine" style={{ marginTop: 4 }}>{describePause(sources)}</div>
                  {confirmResume ? (
                    <div style={{ marginTop: 8 }}>
                      <Note tone="warn">
                        {describePause(sources)} Resuming clears every pause on this account, including theirs. If you
                        do not know why they paused it, find out before you continue.
                      </Note>
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                        <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => setConfirmResume(false)}>Keep paused</button>
                        <button type="button" className="btn sm" disabled={!canSign || busy !== null} onClick={() => void send('resume')}>
                          {busy === 'resume' ? 'Resuming…' : 'Resume anyway'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn sm"
                      style={{ marginTop: 6 }}
                      disabled={!canSign || busy !== null}
                      onClick={() => (resumeNeedsWarning(sources) ? setConfirmResume(true) : void send('resume'))}
                    >
                      {busy === 'resume' ? 'Resuming…' : 'Resume trading'}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <Badge tone="ok">On</Badge>
                  <div className="fine" style={{ marginTop: 4 }}>
                    Pausing stops rebalancing and selling through the fund for this account. Your assets stay in the
                    account, and you can still withdraw them with your wallet.
                  </div>
                  <button type="button" className="btn ghost sm" style={{ marginTop: 6 }} disabled={!canSign || busy !== null} onClick={() => void send('pause')}>
                    {busy === 'pause' ? 'Pausing…' : 'Pause trading'}
                  </button>
                </>
              )}
            </dd>
            {allowance !== null && allowanceState !== null && allowance.cap > 0n && (
              <>
                <dt>buy allowance</dt>
                <dd>
                  {allowanceState.exhausted ? <Badge tone="warn">Used up</Badge> : null}
                  <div className={allowanceState.exhausted ? 'fine' : undefined} style={allowanceState.exhausted ? { marginTop: 4 } : undefined}>
                    {allowanceState.exhausted
                      ? buyLimitMessage(allowanceState.nextBuyAt)
                      : `${fmt(allowance.bought, usdtDecimals)} of ${fmt(allowance.cap, usdtDecimals)} ${usdtSymbol} bought in the current 24-hour window`}
                  </div>
                </dd>
              </>
            )}
          </dl>
          {done === null ? null : <p className="fine pos" role="status" style={{ marginTop: 8 }}>{done}</p>}
          <ErrorNote error={error} />
        </div>
      </section>
    </>
  );
}

function fmt(value: bigint, decimals: number): string {
  return Number(formatUnits(value, decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
