import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { ApiError, getRebalancePlan, postRebalance } from '../../lib/api';
import { approveCalldata, readAllowance, sendSudoCalls } from '../../lib/kernel';
import type { RenewalWallet } from '../../lib/kernel';
import { useWallet } from '../../store/wallet';
import type { PortfolioStatus, RebalanceResult } from '../../lib/api';
import { formatBps, formatUsdE8, shortAddress } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useSession } from '../../store/session';
import { Badge, ErrorNote, Note, Spinner } from '../../components/ui';

/**
 * 再平衡：真的用 session key 送一筆鏈上交易。
 *
 * 三個刻意的設計：
 * 1. **前端不猜要換什麼。** 規劃在後端（DB 價格 + 鏈上報價 + impact 上限），回應裡的 `steps` 才是
 *    真的送出去的參數。在這裡顯示一份「預計」等於給使用者一個會被推翻的承諾。
 * 2. **確認要看得到後果。** 送出前顯示漂移現況、門檻、以及「這會動錢」；不是一顆直接生效的按鈕。
 * 3. **`403 OPERATOR_REBALANCE_DISABLED` 講清楚。** 那個 403 不是權限錯誤，是這個部署沒開開關 ——
 *    把它跟「你沒登入」混在一起會讓人往錯的方向查。
 */
export function RebalanceCard({ status }: { status: PortfolioStatus }): ReactNode {
  const token = useSession((state) => state.token);
  const queryClient = useQueryClient();

  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RebalanceResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const needs = status.drift.needsRebalance;
  const blocked = status.blocked.length > 0;

  const plan = useQuery({
    queryKey: queryKeys.plan(token, status.portfolioId),
    queryFn: () => getRebalancePlan(token as string, status.portfolioId),
    enabled: token !== null && needs && !blocked,
  });
  const planOutcome = plan.data?.outcome ?? null;
  const canRun = planOutcome === 'ready';

  const walletState = useWallet();
  /**
   * allowance 是**新投組最常見的卡點**：`AtpExecutor` 用 `safeTransferFrom` 從帳戶拉幣，而
   * `POST /portfolios` 不會開、session key 也開不了（CallPolicy 只白名單 executeRebalance）。
   * 所以這裡讓 owner 錢包直接簽一筆 sudo UserOp 開下去 —— 這是唯一合法的簽名者。
   */
  const renewalWallet: RenewalWallet | null =
    walletState.kind === 'injected' && walletState.provider !== null && walletState.address !== null
      ? { kind: 'injected', address: walletState.address as Address, provider: walletState.provider }
      : walletState.kind === 'dev' && walletState.devSigner !== null
        ? { kind: 'dev', address: walletState.devSigner.address as Address, account: walletState.devSigner.account }
        : null;

  const [allowances, setAllowances] = useState<{ symbol: string; token: string; allowance: bigint }[] | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<unknown>(null);
  const [approveTx, setApproveTx] = useState<string | null>(null);

  const executor = status.executorAddress;
  // 全部資產都 approve 過 → UI 收成一行（那段說明只在第一次有用）。
  const allApproved = allowances !== null && allowances.length > 0 && allowances.every((row) => row.allowance > 0n);
  const probeAllowances = useCallback(async () => {
    // 讀 allowance 不需要錢包（純讀取）—— 只有 approve 才需要 owner 簽名。
    if (executor === null) return;
    setApproveError(null);
    try {
      const rows = await Promise.all(
        status.targets.map(async (target) => ({
          symbol: target.symbol,
          token: target.asset,
          allowance:
            target.asset.toLowerCase() === executor.toLowerCase()
              ? 0n
              : await readAllowance({
                  wallet: renewalWallet,
                  token: target.asset as Address,
                  owner: status.account as Address,
                  spender: executor as Address,
                }),
        })),
      );
      setAllowances(rows);
    } catch (cause) {
      setApproveError(cause);
    }
  }, [executor, renewalWallet, status.account, status.targets]);
  // 進頁面就探一次：不探就永遠不知道已 approve，那種情況使用者會一直看到那段長說明。
  // 成本是每個資產一次 （我們的基金 2–3 個），比讓使用者手動按一次值得。
  useEffect(() => {
    void probeAllowances();
  }, [probeAllowances]);

  const doApprove = useCallback(async () => {
    if (renewalWallet === null || executor === null || token === null) return;
    setApproving(true);
    setApproveError(null);
    try {
      const receipt = await sendSudoCalls({
        wallet: renewalWallet,
        token,
        accountAddress: status.account as Address,
        calls: status.targets
          // 只 approve 策略裡的代幣；numeraire 也是策略資產，所以照樣要開（它就是要被拉走的那個）。
          .map((target) => ({
            to: target.asset as Address,
            data: approveCalldata(executor as Address),
            value: 0n,
          })),
      });
      setApproveTx(receipt.txHash);
      await probeAllowances();
      await queryClient.invalidateQueries({ queryKey: queryKeys.status(token, status.portfolioId) });
      await plan.refetch();
    } catch (cause) {
      setApproveError(cause);
    } finally {
      setApproving(false);
    }
  }, [executor, plan, probeAllowances, queryClient, renewalWallet, status.account, status.portfolioId, status.targets, token]);

  /**
   * 送出前的 dry-run 預覽。**這是這個卡片最重要的一塊**：使用者按下去之前就該知道
   * 「這一輪不會動、以及為什麼」（例如市場偏離 TWAP 讓 impact 預算做不了事）。
   *
   * 只在「真的需要再平衡而且沒被 blocked」時抓 —— 其餘情況卡片已經自己說明了，不必再花 2–3 秒讀鏈。
   */


  const run = useCallback(async () => {
    if (token === null) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const sent = await postRebalance(token, status.portfolioId);
      setResult(sent);
      setConfirmed(false);
      // 狀態與列表都要重抓：這一輪可能已經改變持倉與 next_run_at。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.status(token, status.portfolioId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) }),
        // 這一輪做過之後，下一次的預覽一定不同（持倉變了）。
        queryClient.invalidateQueries({ queryKey: queryKeys.plan(token, status.portfolioId) }),
      ]);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }, [queryClient, status.portfolioId, token]);

  const disabledReason = blocked
    ? `${status.blocked.length} legs are blocked — resolve those before triggering manually (the scheduler would refuse them anyway)`
    : !needs
      ? `Drift ${status.drift.grossDriftBps} bps is below the ${status.drift.thresholdBps} bps threshold — nothing to do this round`
      : null;

  const outcomeTone =
    result === null
      ? 'neutral'
      : result.outcome === 'executed'
        ? 'ok'
        : result.outcome === 'noop'
          ? 'warn'
          : 'bad';

  return (
    <section className="card stack">
      <div>
        <p className="eyebrow">Rebalance</p>
        <h2>Run a round now</h2>
        <p className="lead" style={{ fontSize: 13 }}>
          The backend plans it (prices, impact budget, the no-op guard) and sends it with the{' '}
          <strong>session key</strong>. No signature prompt appears in your wallet — it is the session key signing,
          not the owner.
        </p>
      </div>

      <dl className="kv">
        <dt>Drift</dt>
        <dd>
          <strong>{status.drift.grossDriftBps} bps</strong>
          <span className="muted"> / threshold {status.drift.thresholdBps} bps · largest single delta </span>
          {formatBps(status.drift.maxAbsDeltaBps)}
        </dd>
        <dt>Total value</dt>
        <dd>{formatUsdE8(status.totalUsdE8)}</dd>
        <dt>block</dt>
        <dd className="mono">#{status.block} (observation point)</dd>
      </dl>

      {disabledReason === null ? null : (
        <>
          <Note tone="warn">{disabledReason}</Note>
          {/* 沒有需要動的時候刻意不跑 dry-run：它要讀鏈、估價、算 impact（實測 2–3 秒）。
              寫出來是因為「什麼都沒發生」與「壞掉了」在畫面上長得一樣。 */}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            No dry-run was made — it only runs when a rebalance is actually needed, to save a 2–3 second chain read.
          </p>
        </>
      )}

      {/* allowance：新投組最常見的卡點。owner 錢包簽一筆 sudo UserOp 就能解決。
          已 approve 之後**收成一行** —— 那段「為什麼需要 approve」的說明只在第一次有用。 */}
      {executor === null ? null : allApproved ? (
        <div className="row" style={{ gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="pos" style={{ fontSize: 13 }}>
              Allowance ok
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              the executor can pull every asset in this fund
            </span>
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={renewalWallet === null}
            onClick={() => void probeAllowances()}
          >
            Re-check
          </button>
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Allowance
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={renewalWallet === null}
              onClick={() => void probeAllowances()}
            >
              {allowances === null ? 'Check allowance' : 'Re-check'}
            </button>
          </div>

          {allowances === null ? (
            <Note>
              The executor pulls tokens from the account with <code>safeTransferFrom</code>, so the account must
              approve it first. A session key cannot do this (its CallPolicy only allows <code>executeRebalance</code>)
              and enrolling does not do it either — so a brand-new fund is blocked at its first rebalance until the
              owner approves once. Connect the owner wallet and press Check allowance.
            </Note>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th className="num">Allowance</th>
                  </tr>
                </thead>
                <tbody>
                  {allowances.map((row) => (
                    <tr key={row.token}>
                      <td>{row.symbol}</td>
                      <td className={`num ${row.allowance > 0n ? 'pos' : 'neg'}`}>
                        {row.allowance > 0n ? 'approved' : '0 — not approved'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {allowances.every((row) => row.allowance > 0n) ? null : (
                <div className="row">
                  <button
                    type="button"
                    className="btn btn--primary"
                    style={{ maxWidth: 280 }}
                    disabled={approving || renewalWallet === null}
                    onClick={() => void doApprove()}
                  >
                    {approving ? 'Approving…' : 'Approve assets (owner signature)'}
                  </button>
                  {renewalWallet === null ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      connect the owner wallet first
                    </span>
                  ) : null}
                </div>
              )}
            </>
          )}

          {approveTx === null ? null : (
            <Note>
              Approved on-chain. tx <span className="mono">{approveTx}</span>
            </Note>
          )}
          <ErrorNote error={approveError} />
        </div>
      )}

      {/* 預覽：按下去之前就知道會發生什麼 */}
      {disabledReason === null ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              What this round would do
              {/* 分析時間要看得見：市場會動，一份 5 分鐘前的分析與現在可能結論不同。
                  沒有時間戳時，「預覽說不會動、結果卻是 executed」看起來像 bug。 */}
              {plan.dataUpdatedAt === 0 ? null : (
                <span style={{ marginLeft: 8, letterSpacing: 0, textTransform: 'none' }}>
                  analysed at {new Date(plan.dataUpdatedAt).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
              )}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={plan.isFetching}
              onClick={() => {
                // 兩個都要重抓。只重算 plan 會留下一個舊的 status（總值、漂移、block 都是 10 秒快取），
                // 實際看到的症狀是「總值 $0.00 / drift 5000」旁邊掛著一份剛算好的 ready 計畫 ——
                // 看起來像系統自相矛盾，其實只是兩個查詢的新鮮度不同。
                void plan.refetch();
                void queryClient.invalidateQueries({ queryKey: queryKeys.status(token, status.portfolioId) });
              }}
            >
              {plan.isFetching ? 'Analysing…' : 'Re-analyse'}
            </button>
          </div>

          {plan.isPending ? (
            <div className="row">
              <Spinner />
              <span className="muted" style={{ fontSize: 13 }}>
                Running a dry-run (reads chain, prices, computes impact; 2–3s in practice)
              </span>
            </div>
          ) : plan.error !== null && plan.error !== undefined ? (
            <ErrorNote error={plan.error} />
          ) : plan.data === undefined ? null : plan.data.outcome === 'ready' ? (
            <Note>
              <div className="row" style={{ gap: 8 }}>
                <Badge tone="ok">Would send {plan.data.steps.length} step(s)</Badge>
              </div>
              <div style={{ marginTop: 6 }}>{plan.data.reason}</div>
            </Note>
          ) : plan.data.outcome === 'noop' ? (
            <Note tone="warn">
              <div className="row" style={{ gap: 8 }}>
                <Badge tone="warn">Nothing would happen</Badge>
                <span className="muted" style={{ fontSize: 12 }}>
                  Not an error: the backend computed that sending would be pointless
                </span>
              </div>
              <div style={{ marginTop: 6 }}>{plan.data.reason}</div>
            </Note>
          ) : (
            <Note tone="bad">
              <div className="row" style={{ gap: 8 }}>
                <Badge tone="bad">Blocked</Badge>
              </div>
              <div style={{ marginTop: 6 }}>{plan.data.reason}</div>
            </Note>
          )}
        </div>
      ) : null}

      {disabledReason === null ? (
        <>
          <label className="row" style={{ gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I understand this sends an on-chain transaction with the session key, moves the fund's money, and the account pays gas
          </label>
          <div className="row">
            <button
              type="button"
              className="btn btn--primary"
              style={{ maxWidth: 260 }}
              disabled={!confirmed || busy || !canRun}
              onClick={() => void run()}
            >
              {busy ? 'Sending and waiting for the receipt…' : canRun ? 'Confirm and send' : 'Nothing to do (see above)'}
            </button>
            {busy ? <span className="muted" style={{ fontSize: 12 }}>The backend plans, estimates gas, sends the op and waits for the receipt</span> : null}
          </div>
        </>
      ) : null}

      {error instanceof ApiError && error.code === 'OPERATOR_REBALANCE_DISABLED' ? (
        <Note tone="bad">
          <strong>The backend has this endpoint switched off (not a permission problem)</strong>
          <div style={{ marginTop: 6 }}>
            This is an operator endpoint: it can move money with the session key, so it fails closed by default. Start the backend with
            <code className="mono">ENABLE_OPERATOR_REBALANCE=true</code> for the endpoint to exist at all.
          </div>
          <div style={{ marginTop: 6, opacity: 0.8 }}>Backend said: {error.message}</div>
        </Note>
      ) : (
        <ErrorNote error={error} />
      )}

      {result === null ? null : (
        <div className="stack">
          <div className="spread">
            <h3 style={{ fontSize: 15 }}>
              Result ·{' '}
              <span
                className={`badge ${outcomeTone === 'ok' ? 'badge--ok' : outcomeTone === 'warn' ? 'badge--warn' : 'badge--bad'}`}
              >
                {result.outcome}
              </span>
              {/* 「這是剛剛那一次執行的結果」——上面的預覽是**現在**的分析，兩者時間點不同。
                  沒有這行時，一個已完成的 executed 結果旁邊掛著「這一輪不會動」看起來自相矛盾。 */}
              <span className="muted" style={{ marginLeft: 8, fontSize: 12, fontWeight: 400 }}>
                this is the round that was sent; the preview above is the current analysis
              </span>
            </h3>
            {result.swapExecuted === null ? null : (
              <span className="muted mono" style={{ fontSize: 12 }}>
                SwapExecuted {result.swapExecuted}/{result.expectedSwaps}
              </span>
            )}
          </div>

          <Note tone={result.outcome === 'executed' ? 'neutral' : result.outcome === 'noop' ? 'warn' : 'bad'}>
            {result.reason}
          </Note>

          <dl className="kv">
            {result.txHash === null ? null : (
              <>
                <dt>tx</dt>
                <dd className="mono" style={{ wordBreak: 'break-all' }}>
                  {result.txHash}
                </dd>
              </>
            )}
            {result.userOpHash === null ? null : (
              <>
                <dt>userOp</dt>
                <dd className="mono" style={{ wordBreak: 'break-all' }}>
                  {result.userOpHash}
                </dd>
              </>
            )}
            {result.gasUsed === null ? null : (
              <>
                <dt>gasUsed</dt>
                <dd className="mono">{result.gasUsed}</dd>
              </>
            )}
          </dl>

          {result.steps.length === 0 ? null : (
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>tokenIn</th>
                  <th>tokenOut</th>
                  <th className="num">amountIn</th>
                  <th className="num">amountOutMin</th>
                </tr>
              </thead>
              <tbody>
                {result.steps.map((step, index) => (
                  <tr key={`${step.tokenIn}-${step.tokenOut}-${index}`}>
                    <td className="num">{index + 1}</td>
                    <td className="mono">{shortAddress(step.tokenIn)}</td>
                    <td className="mono">{shortAddress(step.tokenOut)}</td>
                    <td className="num">{step.amountIn}</td>
                    <td className="num">{step.amountOutMin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <Note>
            Want to see what this round actually did to the holdings? Reload the status above — the backend keeps a
            snapshot before and after every round (<code>phase = before / after</code>); the difference is what happened.
          </Note>
        </div>
      )}
    </section>
  );
}
