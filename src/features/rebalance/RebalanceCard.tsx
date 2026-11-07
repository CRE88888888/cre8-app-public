import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, getRebalancePlan, postRebalance } from '../../lib/api';
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

  /**
   * 送出前的 dry-run 預覽。**這是這個卡片最重要的一塊**：使用者按下去之前就該知道
   * 「這一輪不會動、以及為什麼」（例如市場偏離 TWAP 讓 impact 預算做不了事）。
   *
   * 只在「真的需要再平衡而且沒被 blocked」時抓 —— 其餘情況卡片已經自己說明了，不必再花 2–3 秒讀鏈。
   */
  const plan = useQuery({
    queryKey: queryKeys.plan(token, status.portfolioId),
    queryFn: () => getRebalancePlan(token as string, status.portfolioId),
    enabled: token !== null && needs && !blocked,
  });
  const planOutcome = plan.data?.outcome ?? null;
  const canRun = planOutcome === 'ready';

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
    ? `有 ${status.blocked.length} 個部位被擋下 —— 先處理 blocked 再手動觸發（不然排程器會在送出前自己擋掉）`
    : !needs
      ? `漂移 ${status.drift.grossDriftBps} bps 未達門檻 ${status.drift.thresholdBps} bps，這一輪不需要動`
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
        <p className="eyebrow">再平衡</p>
        <h2>現在執行一輪</h2>
        <p className="lead" style={{ fontSize: 13 }}>
          由後端規劃（價格、衝擊上限、避免空轉的守衛）並用 <strong>session key</strong> 送出。
          你不會在錢包裡看到簽名視窗 —— 簽的是 session key，不是 owner。
        </p>
      </div>

      <dl className="kv">
        <dt>漂移</dt>
        <dd>
          <strong>{status.drift.grossDriftBps} bps</strong>
          <span className="muted"> / 門檻 {status.drift.thresholdBps} bps · 最大單一差 </span>
          {formatBps(status.drift.maxAbsDeltaBps)}
        </dd>
        <dt>總價值</dt>
        <dd>{formatUsdE8(status.totalUsdE8)}</dd>
        <dt>block</dt>
        <dd className="mono">#{status.block}（這份判定的觀測點）</dd>
      </dl>

      {disabledReason === null ? null : (
        <>
          <Note tone="warn">{disabledReason}</Note>
          {/* 沒有需要動的時候刻意不跑 dry-run：它要讀鏈、估價、算 impact（實測 2–3 秒）。
              寫出來是因為「什麼都沒發生」與「壞掉了」在畫面上長得一樣。 */}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            沒有跑 dry-run —— 只有真的需要再平衡時才會分析（省一次 2–3 秒的讀鏈）。
          </p>
        </>
      )}

      {/* 預覽：按下去之前就知道會發生什麼 */}
      {disabledReason === null ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              這一輪會做什麼
              {/* 分析時間要看得見：市場會動，一份 5 分鐘前的分析與現在可能結論不同。
                  沒有時間戳時，「預覽說不會動、結果卻是 executed」看起來像 bug。 */}
              {plan.dataUpdatedAt === 0 ? null : (
                <span style={{ marginLeft: 8, letterSpacing: 0, textTransform: 'none' }}>
                  分析於 {new Date(plan.dataUpdatedAt).toLocaleTimeString('zh-TW', { hour12: false })}
                </span>
              )}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={plan.isFetching}
              onClick={() => void plan.refetch()}
            >
              {plan.isFetching ? '分析中…' : '重新分析'}
            </button>
          </div>

          {plan.isPending ? (
            <div className="row">
              <Spinner />
              <span className="muted" style={{ fontSize: 13 }}>
                跑一次 dry-run（讀鏈、估價、算 impact；實測 2–3 秒）
              </span>
            </div>
          ) : plan.error !== null && plan.error !== undefined ? (
            <ErrorNote error={plan.error} />
          ) : plan.data === undefined ? null : plan.data.outcome === 'ready' ? (
            <Note>
              <div className="row" style={{ gap: 8 }}>
                <Badge tone="ok">會送出 {plan.data.steps.length} 個 step</Badge>
              </div>
              <div style={{ marginTop: 6 }}>{plan.data.reason}</div>
            </Note>
          ) : plan.data.outcome === 'noop' ? (
            <Note tone="warn">
              <div className="row" style={{ gap: 8 }}>
                <Badge tone="warn">這一輪不會動</Badge>
                <span className="muted" style={{ fontSize: 12 }}>
                  不是錯誤：後端算過之後認為送出去沒有意義
                </span>
              </div>
              <div style={{ marginTop: 6 }}>{plan.data.reason}</div>
            </Note>
          ) : (
            <Note tone="bad">
              <div className="row" style={{ gap: 8 }}>
                <Badge tone="bad">被擋下</Badge>
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
            我知道這會用 session key 送出鏈上交易、動到投組裡的錢，而且 gas 由帳戶支付
          </label>
          <div className="row">
            <button
              type="button"
              className="btn btn--primary"
              style={{ maxWidth: 260 }}
              disabled={!confirmed || busy || !canRun}
              onClick={() => void run()}
            >
              {busy ? '送出並等待 receipt…' : canRun ? '確認執行' : '這一輪不會動（見上方說明）'}
            </button>
            {busy ? <span className="muted" style={{ fontSize: 12 }}>後端要規劃、估 gas、送 op、等 receipt</span> : null}
          </div>
        </>
      ) : null}

      {error instanceof ApiError && error.code === 'OPERATOR_REBALANCE_DISABLED' ? (
        <Note tone="bad">
          <strong>後端沒開這個端點（不是權限問題）</strong>
          <div style={{ marginTop: 6 }}>
            這是 operator 端點：它能用 session key 動錢，所以預設 fail-closed。要在後端啟動時帶上
            <code className="mono"> ENABLE_OPERATOR_REBALANCE=true</code>，端點才會存在。
          </div>
          <div style={{ marginTop: 6, opacity: 0.8 }}>後端原文：{error.message}</div>
        </Note>
      ) : (
        <ErrorNote error={error} />
      )}

      {result === null ? null : (
        <div className="stack">
          <div className="spread">
            <h3 style={{ fontSize: 15 }}>
              結果 ·{' '}
              <span
                className={`badge ${outcomeTone === 'ok' ? 'badge--ok' : outcomeTone === 'warn' ? 'badge--warn' : 'badge--bad'}`}
              >
                {result.outcome}
              </span>
              {/* 「這是剛剛那一次執行的結果」——上面的預覽是**現在**的分析，兩者時間點不同。
                  沒有這行時，一個已完成的 executed 結果旁邊掛著「這一輪不會動」看起來自相矛盾。 */}
              <span className="muted" style={{ marginLeft: 8, fontSize: 12, fontWeight: 400 }}>
                這是已送出那一次的結果；上方預覽是現在的分析
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
            想看這一輪到底讓持倉變成什麼樣？狀態頁上方重新載入即可 —— 後端在送出前後各留了一張快照
            （`phase = before / after`），差額就是這一輪做了什麼。
          </Note>
        </div>
      )}
    </section>
  );
}
