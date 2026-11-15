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
  upgradeDoneMessage,
  upgradeSummary,
  PLATFORM_PAUSED_MESSAGE,
} from '../../lib/a10';
import type { PauseSource } from '../../lib/a10';
import { readOnchainAccount, setPausedCalldata, upgradeCalls } from '../../lib/atp-contracts';
import type { AccountCall, OnchainAccount, OnchainAllocation } from '../../lib/atp-contracts';
import { publicClientFor, sendSudoCalls } from '../../lib/kernel';
import { upgradeBatches } from '../../lib/approval-batches';
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
 *
 * 升版時，新版本多出來的資產會在**同一個 UserOp** 裡一起 `approve(executor, max)`（cre8-app#50）：
 * 不然升版成功、下一輪再平衡卻因為 allowance 不足被擋，使用者得另外再簽一筆。
 */
export function AccountControls({
  wallet,
  token,
  account,
  executor,
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
  /** executor 位址（新資產 approve 的對象，也是重讀鏈上狀態的起點）。null = 後端沒有給。 */
  executor: string | null;
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
  /** 新版本多出來的資產（代號）：升版時會一起授權。 */
  const addedSymbols = changes.filter((row) => row.kind === 'added').map((row) => symbolOf(row.asset));
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
      let calls: AccountCall[];
      let upgraded: { version: number; symbols: string[] } | null = null;
      /** enroll 打的 registry（升版時用剛重讀的那一個）。 */
      let registry: string = state.registry;
      if (kind === 'upgrade') {
        // 送出前重讀一次鏈上狀態（cre8-app#50）：`enroll` 釘的是**送出當下**的最新版本，
        // 要授權的新資產必須照那一版算，不能照畫面上可能已經過時的那一版。
        if (executor === null) throw new Error('The fund executor address is not known, so the update cannot be prepared. Reload and try again.');
        let fresh: OnchainAccount;
        try {
          fresh = await readOnchainAccount(publicClientFor(wallet), executor as Address, account as Address);
        } catch (cause) {
          throw new Error(`Could not read the fund registry, so nothing was sent: ${(cause as Error).message.split('\n')[0]}`);
        }
        if (fresh.current === null || fresh.latest === null || fresh.latestVersion <= fresh.version) {
          await onChanged();
          throw new Error('This account is already on the latest version. Nothing was sent.');
        }
        // 使用者看的是 v{state.latestVersion} 的差異表；期間又發了更新的版本，就不能讓他簽一個沒看過的版本。
        if (fresh.latestVersion !== state.latestVersion) {
          await onChanged();
          throw new Error(`Version ${fresh.latestVersion} was published while you were reviewing version ${state.latestVersion}. Nothing was sent — check the new changes and update again.`);
        }
        const plan = upgradeCalls({
          registry: fresh.registry,
          executor: executor as Address,
          account: account as Address,
          strategyOnchainId: fresh.strategyId,
          current: fresh.current,
          latest: fresh.latest,
        });
        calls = plan.calls;
        registry = fresh.registry;
        upgraded = { version: fresh.latestVersion, symbols: plan.newAssets.map(symbolOf) };
      } else {
        calls = [{ to: state.registry, data: setPausedCalldata(account as Address, kind === 'pause'), value: 0n }];
      }
      // 升版：approve 每 32 個一筆、enroll 在最後一批（`upgradeBatches`，cre8-app#93）。暫停／恢復只有一個 call。
      const batches = kind === 'upgrade' ? upgradeBatches(calls, registry) : [calls];
      let receipt: Awaited<ReturnType<typeof sendSudoCalls>> | null = null;
      for (const [index, batch] of batches.entries()) {
        if (batches.length > 1) toast.replace(id, { tone: 'pending', title, body: `Signature ${index + 1} of ${batches.length}…` });
        receipt = await sendSudoCalls({
          wallet,
          token,
          accountAddress: account as Address,
          strategyId: dbStrategyId,
          calls: batch,
        });
        if (!receipt.success) throw new Error(`The transaction landed on-chain but reverted: ${receipt.txHash}`);
      }
      if (receipt === null) throw new Error('Nothing to send.');
      const message =
        upgraded !== null
          ? upgradeDoneMessage(upgraded.version, upgraded.symbols)
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
                    {upgradeSummary(addedSymbols)}
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
