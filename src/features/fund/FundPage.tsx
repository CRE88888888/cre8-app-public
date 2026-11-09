import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { encodeFunctionData, formatUnits, parseUnits } from 'viem';
import type { Address } from 'viem';
import { enrollPortfolio, getAssets, getPortfolioStatus, getPortfolios, listStrategies, redeemPortfolio } from '../../lib/api';
import { sendWithdraw } from '../../lib/kernel';
import type { PortfolioStatus } from '../../lib/api';
import { MOCK_FUNDS } from '../../data/mock-funds';
import { MOCK_PERFORMANCE } from '../../data/mock-performance';
import { shortAddress } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import { useOwnerWallet } from '../../lib/use-owner-wallet';
import { useSession } from '../../store/session';
import { AssetLogo } from '../../components/AssetLogo';
import { SignInButton } from '../../components/WalletMenu';
import { ErrorNote, Note, Spinner } from '../../components/ui';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

const PERIODS = ['7D', '30D', '90D', '1Y', 'ALL'] as const;
type Period = (typeof PERIODS)[number];

/** 參考站 `.chart` 的走勢圖：330×190、grid 線、漸層填色。 */
function VaultChart({
  points,
  positive,
  label,
}: {
  points: readonly (readonly [number, number])[];
  positive: boolean;
  label: string;
}): ReactNode {
  if (points.length < 2) return null;
  // 參考站的點是 320×64 的座標，這裡縮放到 330×190 的繪圖區（留 8px 邊）。
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // viewBox 660×220：圖表要填滿容器寬度，用 330 會左右留白（參考站的 svg 是配合固定寬度畫的）。
  const sx = (x: number) => 8 + ((x - minX) / (maxX - minX || 1)) * 644;
  const sy = (y: number) => 16 + ((y - minY) / (maxY - minY || 1)) * 176;

  const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');
  const area = `${line} L${sx(maxX).toFixed(1)},206 L${sx(minX).toFixed(1)},206 Z`;
  const tone = positive ? 'var(--positive)' : 'var(--negative)';

  return (
    <svg viewBox="0 0 660 220" role="img" aria-label={label} style={{ height: 220, width: '100%' }}>
      <defs>
        <linearGradient id="vault-chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--fog)" stopOpacity=".28" />
          <stop offset="1" stopColor="var(--fog)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map((row) => (
        <line key={row} className="grid" x1="8" x2="652" y1={46 + row * 40} y2={46 + row * 40} />
      ))}
      <path d={area} fill="url(#vault-chart-fill)" stroke="none" />
      <path d={line} fill="none" stroke={tone} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={sx(xs[xs.length - 1] ?? 0)} cy={sy(ys[ys.length - 1] ?? 0)} r="2.6" fill={tone} />
    </svg>
  );
}

/** 美元顯示（提領說明用；`$12.34`）。 */
function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(bps: number, digits = 2): string {
  const sign = bps < 0 ? '−' : '';
  return `${sign}${(Math.abs(bps) / 100).toFixed(digits)}%`;
}

/**
 * 基金頁 —— 對齊參考站 `app.cre8.finance/vault/<slug>` 的版面。
 *
 * 版面不是自己發明的：沿用設計稿的 `.vgrid / .vhead / .keyfig / .vault-performance /
 * .vault-where / .ticket / .pros-drawer`（樣式已在 `styles/vendor/design.css`）。
 * 左欄是「這檔基金是什麼、錢在哪」，右欄 `aside.side` 是**下單用的 ticket**。
 *
 * 兩種身份放在同一頁：
 *   1. 目錄頁：範例基金的 thesis / 走勢 / 配置（純前端資料）
 *   2. 真實策略：用名稱比對接到鏈上策略（Elon Universe → strategy 529），顯示即時配置，
 *      並讓使用者把 USDT 轉進**自己的** Kernel 帳戶（存款＝ERC-20 transfer，不需要 approve）
 */
export function FundPage(): ReactNode {
  useBodyClass('vault-page');
  const { slug } = useParams<{ slug: string }>();
  const token = useSession((state) => state.token);
  const wallet = useOwnerWallet();
  const queryClient = useQueryClient();

  const fund = MOCK_FUNDS.find((entry) => entry.slug === slug);
  const performance = fund === undefined ? undefined : MOCK_PERFORMANCE[fund.slug];

  const strategies = useQuery({
    queryKey: ['strategies', token],
    queryFn: () => listStrategies(token as string),
    enabled: token !== null,
  });
  const assets = useQuery({
    queryKey: ['assets', token],
    queryFn: () => getAssets(token as string),
    enabled: token !== null,
    staleTime: 60_000,
  });
  const portfolios = useQuery({
    queryKey: queryKeys.portfolios(token),
    queryFn: () => getPortfolios(token as string),
    enabled: token !== null,
  });

  const strategy = useMemo(
    () => (fund === undefined ? undefined : (strategies.data?.items ?? []).find((item) => item.name === fund.name)),
    [fund, strategies.data],
  );
  const holding = (portfolios.data ?? []).find((portfolio) => portfolio.strategyId === strategy?.id);
  const usdt = (assets.data ?? []).find((asset) => asset.isNumeraire);

  const status = useQuery({
    queryKey: ['fund-status', token, holding?.id],
    queryFn: () => getPortfolioStatus(token as string, holding?.id as number),
    enabled: token !== null && holding !== undefined,
    staleTime: 15_000,
    retry: 0,
  });

  const [period, setPeriod] = useState<Period>('1Y');
  // `?tab=withdraw` 直接開提領分頁 —— 分頁狀態本來只在記憶體裡，沒有網址就只能靠手動點。
  const [search] = useSearchParams();
  const [tab, setTab] = useState<'deposit' | 'withdraw'>(search.get('tab') === 'withdraw' ? 'withdraw' : 'deposit');
  const [amount, setAmount] = useState('1000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [facts, setFacts] = useState(false);
  // 提領：預設 USDT（現金腿），可選帳戶裡任何有餘額的資產 —— 每個都只是一筆 transfer。
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawError, setWithdrawError] = useState<unknown>(null);
  const [withdrawTx, setWithdrawTx] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  if (fund === undefined) {
    return (
      <main className="wrap vault-content">
        <Note tone="bad">No fund with slug “{slug}”.</Note>
        <p>
          <Link to="/vaults">← All funds</Link>
        </p>
      </main>
    );
  }

  // 走勢圖的期間切換：我們的序列是等距抽樣，所以「切一段」就是取尾端比例。
  const sliced = (() => {
    if (performance === undefined) return [];
    const points = performance.points;
    const keep = period === 'ALL' ? points.length : period === '7D' ? 4 : period === '30D' ? 8 : period === '90D' ? 16 : 24;
    return points.slice(Math.max(0, points.length - keep));
  })();

  const live = status.data;
  const rows = live === undefined
    ? fund.holdings.map((row) => ({ symbol: row.symbol, targetBps: row.weightBps, currentBps: null as number | null }))
    : (live.drift.assets ?? []).map((row) => ({ symbol: row.symbol, targetBps: row.targetBps, currentBps: row.currentBps }));

  const totalBps = rows.reduce((sum, row) => sum + (row.currentBps ?? row.targetBps), 0) || 1;

  return (
    <>
      <main className="wrap vault-content">
        <div className="vgrid">
          <div className="main">
            <div className="vault-top">
              <header className="vhead">
                <Link className="vault-back" to="/vaults">
                  ← All funds
                </Link>
                <div className="vault-heading">
                  <h1>{fund.name}</h1>
                  <p className="vault-manager fact-row">
                    {strategy === undefined ? 'Example fund · not published on-chain' : `Run by CRE8 operator · strategy #${strategy.id}`}
                  </p>
                  <p className="strat dk-sr">{fund.thesis}</p>
                  <dl className="vault-strip">
                    <div>
                      <dt>Run by</dt>
                      <dd>
                        Plan: {fund.rebalance === 'none' ? 'Buy & hold' : fund.rebalance === 'drift' ? 'Rebalance on drift' : 'Monthly rebalance'}
                      </dd>
                    </div>
                    <div>
                      <dt>Assets</dt>
                      <dd>{rows.map((row) => row.symbol).filter((symbol) => symbol !== (usdt?.symbol ?? 'USDT')).join(', ')}</dd>
                    </div>
                    <div>
                      <dt>Lending on</dt>
                      <dd>None</dd>
                    </div>
                  </dl>
                  <div className="vault-head-actions">
                    <button type="button" className="btn ghost" onClick={() => setFacts(true)}>
                      Fund facts
                    </button>
                    <div className="tags">
                      <span className="tag pos">{strategy === undefined ? 'Example' : 'Open'}</span>
                      <span className="tag accounting-chip">Accounting asset: {usdt?.symbol ?? 'USDT'}</span>
                    </div>
                  </div>
                </div>
              </header>

              <dl className="keyfig dk-kpis">
                <div>
                  <dt>Fund size</dt>
                  <dd>
                    {live === undefined || live.totalUsdE8 === null ? '—' : (Number(live.totalUsdE8) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    <small>{usdt?.symbol ?? 'USDT'}</small>
                  </dd>
                </div>
                <div>
                  <dt>Performance Since inception</dt>
                  <dd>
                    <span className={performance === undefined || performance.returnBps >= 0 ? 'pos' : 'neg'}>
                      {performance === undefined ? '—' : pct(performance.returnBps)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Following</dt>
                  <dd>{(portfolios.data ?? []).filter((row) => row.strategyId === strategy?.id).length}</dd>
                </div>
              </dl>
            </div>

            <section className="panel vault-performance">
              <div className="vault-chart-top">
                <p className="vault-chart-drop">
                  <span>Max drop Since inception</span> <b>{performance === undefined ? '—' : pct(performance.maxDropBps)}</b>
                </p>
                <div className="seg">
                  {PERIODS.map((entry) => (
                    <button key={entry} type="button" className={entry === period ? 'on' : ''} onClick={() => setPeriod(entry)}>
                      {entry}
                    </button>
                  ))}
                </div>
              </div>
              <div className="chart">
                <VaultChart
                  points={sliced}
                  positive={(performance?.returnBps ?? 0) >= 0}
                  label={`${fund.name} simulated share price`}
                />
              </div>
              <p className="vault-data-note">
                Simulated series copied from the design reference — it is <strong>not</strong> this deployment&apos;s
                result and not a forecast. The live fund starts when you deposit.
              </p>
            </section>

            <section className="vault-allocation dk-sec">
              <header>
                <h2>Where the money is</h2>
              </header>
              <div className="dk-wrap">
                <table className="dk-table vault-where">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>{live === undefined ? 'Target weight' : 'Current weight'}</th>
                      <th>Venue</th>
                      <th className="dk-hide-sm">Return from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const value = row.currentBps ?? row.targetBps;
                      return (
                        <tr key={row.symbol}>
                          <td className="mono">
                            <strong>{row.symbol}</strong>
                          </td>
                          <td>
                            <span className="dk-w vault-weight">
                              <b>{((value / totalBps) * 100).toFixed(1)}%</b>
                              <i style={{ ['--w' as string]: `${(value / totalBps) * 100}%` }} />
                            </span>
                          </td>
                          <td>In the fund</td>
                          <td className="dk-hide-sm vault-earns">{row.symbol} price</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {live === undefined ? (
                <p className="fine vault-info">
                  {strategy === undefined
                    ? 'Target weights from the catalogue — no on-chain strategy yet.'
                    : 'Target weights from the on-chain version; sign in and open your portfolio to see live weights.'}
                </p>
              ) : (
                <p className="fine vault-info">
                  Live weights at block #{live.block} · drift {live.drift.grossDriftBps} bps (threshold{' '}
                  {live.drift.thresholdBps} bps) ·{' '}
                  <Link to={`/portfolios/${holding?.id}`}>open portfolio #{holding?.id}</Link>
                </p>
              )}
            </section>
          </div>

          <aside className="side">
            <section className="panel ticket">
              <div className="tabs" role="tablist">
                <button type="button" className={tab === 'deposit' ? 'on' : ''} onClick={() => setTab('deposit')}>
                  Deposit
                </button>
                <button type="button" className={tab === 'withdraw' ? 'on' : ''} onClick={() => setTab('withdraw')}>
                  Withdraw
                </button>
              </div>
              <div className="panel-b">
                {tab === 'withdraw' ? (
                  token === null ? (
                    <Note tone="warn">
                      <SignInButton /> to withdraw.
                    </Note>
                  ) : holding === undefined ? (
                    <Note>You do not follow this strategy, so there is nothing to withdraw.</Note>
                  ) : live === undefined ? (
                    <div className="row">
                      <Spinner /> <span className="muted">Reading balances…</span>
                    </div>
                  ) : wallet === null ? (
                    <Note tone="warn">Connect the owner wallet in the header — a withdrawal is an owner-signed UserOp.</Note>
                  ) : (
                    <form
                      className="swap"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void withdraw();
                      }}
                    >
                      <div className="swap-box">
                        <div className="swap-head">
                          <label className="swap-label" htmlFor="withdraw-amount">
                            You receive
                          </label>
                          <span className="swap-picks">
                            <button type="button" onClick={() => setWithdrawAmount(maxWithdrawLabel())}>
                              Max
                            </button>
                          </span>
                        </div>
                        <input
                          id="withdraw-amount"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0"
                          value={withdrawAmount}
                          onChange={(event) => setWithdrawAmount(event.target.value)}
                        />
                        <span className="swap-sub">USDT → {shortAddress(wallet.address)} (your wallet)</span>
                      </div>
                      <p className="fine">
                        Cash {formatUsd(cashUsd())} · positions {formatUsd(Math.max(0, totalUsd() - cashUsd()))} · total{' '}
                        {formatUsd(totalUsd())}
                        {withdrawAmount !== '' && Number(withdrawAmount) > cashUsd() ? (
                          <>
                            <br />
                            The shortfall {formatUsd(Number(withdrawAmount) - cashUsd())} is sold from every position
                            pro-rata first, so the fund stays on its mandate.
                          </>
                        ) : null}
                      </p>
                      <button
                        type="submit"
                        className="btn ghost block"
                        disabled={withdrawBusy || totalUsd() === 0}
                      >
                        {withdrawBusy ? 'Working…' : 'Withdraw in USDT'}
                      </button>
                      {totalUsd() === 0 ? <p className="fine">This account holds nothing yet — deposit first.</p> : null}
                      {gasTooLow(live) ? (
                        <p className="fine">
                          The account needs BNB for gas. Top it up on{' '}
                          <Link to={`/portfolios/${holding.id}`}>the portfolio page</Link> first.
                        </p>
                      ) : null}
                      {withdrawTx === null ? null : (
                        <p className="fine">
                          Withdrawn. tx <span className="mono">{withdrawTx}</span>
                        </p>
                      )}
                      <ErrorNote error={withdrawError} />
                      <p className="fine">
                        Two signatures when cash is short: the fund sells pro-rata with its session key, then you sign
                        one USDT transfer out. Selling the whole position back to cash would break the mandate and the
                        scheduler would buy it straight back — pro-rata does not.
                      </p>
                    </form>
                  )
                ) : token === null ? (
                  <Note tone="warn">
                    <SignInButton /> to deposit.
                  </Note>
                ) : strategies.error !== null && strategies.error !== undefined ? (
                  <ErrorNote error={strategies.error} />
                ) : strategy === undefined ? (
                  <Note>
                    This fund exists only as an example in the catalogue — nobody has published it on-chain yet, so
                    there is nothing to deposit into.
                  </Note>
                ) : holding === undefined ? (
                  <div className="stack" style={{ gap: 10 }}>
                    <Note tone="warn">
                      You do not follow this strategy yet. Following it creates <strong>your own</strong> Kernel smart
                      account for this fund — one account per (owner, strategy), so your balance and session key are
                      independent of every other holder.
                    </Note>
                    <button
                      type="button"
                      className="btn primary block"
                      disabled={enrolling}
                      onClick={() => void follow()}
                    >
                      {enrolling ? 'Creating your account…' : 'Follow this fund'}
                    </button>
                    <ErrorNote error={error} />
                  </div>
                ) : (
                  <form
                    className="swap"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void deposit();
                    }}
                  >
                    <div className="swap-box">
                      <div className="swap-head">
                        <label className="swap-label" htmlFor="deposit-amount">
                          You pay
                        </label>
                        <span className="swap-picks">
                          <button type="button" onClick={() => setAmount('1000')}>
                            1000
                          </button>
                        </span>
                      </div>
                      <input
                        id="deposit-amount"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                      />
                      <span className="swap-sub">
                        {usdt?.symbol ?? 'USDT'} → your account {shortAddress(holding.smartAccounts[0]?.address ?? '')}
                      </span>
                    </div>
                    <button type="submit" className="btn primary block" disabled={busy || wallet === null}>
                      {busy ? 'Sending…' : 'Deposit'}
                    </button>
                    {wallet === null ? <p className="fine">Connect the owner wallet in the header first.</p> : null}
                    {sent === null ? null : (
                      <p className="fine">
                        Deposited. tx <span className="mono">{sent}</span>
                      </p>
                    )}
                    <ErrorNote error={error} />
                  </form>
                )}
              </div>
            </section>

            <section className="panel vault-creator-card">
              <div className="panel-h">
                <h3>Creator</h3>
              </div>
              <div className="panel-b">
                <p className="vcc-id">
                  {/* public/logos 沒有 cre8-icon.svg；放一個壞掉的 <img> 比不放更糟，所以用文字標記。 */}
                  <span className="fund-mark" aria-hidden="true">
                    C8
                  </span>
                  <span>
                    <b>{strategy === undefined ? 'CRE8 catalogue' : shortAddress(strategy.provider)}</b>
                    <small>{strategy === undefined ? 'Design reference only' : `Strategy #${strategy.id}`}</small>
                  </span>
                </p>
                <dl className="vcc-stats">
                  <div>
                    <dt>Funds created</dt>
                    <dd>{strategies.data?.items.length ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Followers</dt>
                    <dd>{(portfolios.data ?? []).filter((row) => row.strategyId === strategy?.id).length}</dd>
                  </div>
                </dl>
              </div>
            </section>
          </aside>
        </div>
      </main>

      {/* Fund facts：參考站是一個右側抽屜（dialog.pros-drawer）。 */}
      {facts ? (
        <dialog className="pros-drawer" open aria-labelledby="pros-title">
          <header className="pros-head">
            <div>
              <p className="label">[ Fund facts ]</p>
              <h2 id="pros-title">{fund.name}</h2>
            </div>
            <button type="button" className="pros-x" aria-label="Close fund facts" onClick={() => setFacts(false)}>
              ×
            </button>
          </header>
          <div className="pros-body">
            <section className="panel pros-sec vault-mandate">
              <div className="panel-h">
                <h3>Mandate</h3>
                <span className="tag">Manifest</span>
              </div>
              <div className="panel-b">
                <p className="sentence">{fund.thesis}</p>
                <table className="dk-table vault-where" style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Target</th>
                      <th>Tradable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const meta = (assets.data ?? []).find((asset) => asset.symbol === row.symbol);
                      return (
                        <tr key={row.symbol}>
                          <td className="mono">
                            <strong>{row.symbol}</strong>
                          </td>
                          <td>{row.targetBps} bps</td>
                          <td>{meta === undefined ? '—' : meta.tradable === true ? 'yes' : meta.tradable === false ? 'no oracle' : 'unknown'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="fine">
                  A version is immutable: changing weights means publishing a new version, and every follower keeps the
                  version it pinned until it re-enrolls.
                </p>
              </div>
            </section>

            <section className="panel pros-sec vault-positions">
              <div className="panel-h">
                <h3>Positions</h3>
                <span className="label">{live === undefined ? '' : `block #${live.block}`}</span>
              </div>
              <div className="panel-b">
                {live === undefined ? (
                  <p className="fine">
                    No live positions — {holding === undefined ? 'you do not hold this fund yet' : 'the status could not be read'}.
                  </p>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th className="r">Balance</th>
                        <th className="r">Value (USDT)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {live.holdings.map((row: PortfolioStatus['holdings'][number]) => (
                        <tr key={row.asset}>
                          <td className="mono">{row.symbol}</td>
                          <td className="r">{formatUnits(BigInt(row.amountWei), row.decimals)}</td>
                          <td className="r">${(Number(row.usdValueE8) / 1e8).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section className="panel pros-sec vault-identity">
              <div className="panel-h">
                <h3>Identity &amp; contracts</h3>
              </div>
              <div className="panel-b">
                <dl className="kv">
                  <dt>strategy</dt>
                  <dd className="mono">{strategy === undefined ? 'not published' : `#${strategy.id} (registry ${strategy.onchainId ?? '—'})`}</dd>
                  <dt>account</dt>
                  <dd className="mono">{holding?.smartAccounts[0]?.address ?? '—'}</dd>
                  <dt>executor</dt>
                  <dd className="mono">{live?.executorAddress ?? '—'}</dd>
                  <dt>session key</dt>
                  <dd className="mono">{live?.sessionKey?.usable?.keyRef ?? '—'}</dd>
                </dl>
              </div>
            </section>
          </div>
        </dialog>
      ) : null}
    </>
  );

  async function deposit(): Promise<void> {
    if (wallet === null || holding === undefined || usdt === undefined) return;
    const account = holding.smartAccounts[0]?.address;
    if (account === undefined) return;
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const value = parseUnits(amount === '' ? '0' : amount, usdt.decimals);
      if (value === 0n) throw new Error('amount must be greater than zero');
      const hash = await sendUsdt(wallet, usdt.address as Address, account as Address, value);
      setSent(hash);
      await queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) });
      await queryClient.invalidateQueries({ queryKey: ['fund-status', token, holding.id] });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  /** 帳戶的 BNB 是否低於一次 UserOp 的門檻（1e16 wei = 0.01 BNB，與後端 `DEFAULT_MIN_SESSION_GAS_WEI` 一致）。 */
  function gasTooLow(status: PortfolioStatus): boolean {
    if (status.gas === null) return true;
    const wei = status.gas.balanceWei;
    if (wei === null || wei === undefined) return true;
    return BigInt(wei) < 10n ** 16n;
  }

  /** 在基金頁直接建立「我的帳戶」（＝enroll），不必繞去 /create。 */
  async function follow(): Promise<void> {
    if (token === null || strategy === undefined) return;
    setEnrolling(true);
    setError(null);
    try {
      await enrollPortfolio(token, strategy.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) });
      await queryClient.invalidateQueries({ queryKey: ['strategies', token] });
    } catch (cause) {
      setError(cause);
    } finally {
      setEnrolling(false);
    }
  }

  /** 帳戶裡的現金（numeraire）價值（美元）。 */
  function cashUsd(): number {
    const row = (live?.holdings ?? []).find((entry) => entry.symbol === (usdt?.symbol ?? 'USDT'));
    return row === undefined ? 0 : Number(row.usdValueE8) / 1e8;
  }

  /** 整個基金價值（美元）。 */
  function totalUsd(): number {
    return live === undefined || live.totalUsdE8 === null ? 0 : Number(live.totalUsdE8) / 1e8;
  }

  function maxWithdrawLabel(): string {
    return totalUsd() === 0 ? '' : totalUsd().toFixed(2);
  }

  async function withdraw(): Promise<void> {
    if (wallet === null || token === null || holding === undefined || live === undefined) return;
    const account = holding.smartAccounts[0]?.address;
    const cash = cashUsd();
    const requested = Number(withdrawAmount === '' ? '0' : withdrawAmount);
    const usdtRow = (live.holdings ?? []).find((entry) => entry.symbol === (usdt?.symbol ?? 'USDT'));
    const usdtAsset = usdt?.address;
    setWithdrawBusy(true);
    setWithdrawError(null);
    setWithdrawTx(null);
    try {
      if (account === undefined || usdtAsset === undefined) throw new Error('找不到帳戶或會計資產');
      if (!Number.isFinite(requested) || requested <= 0) throw new Error('amount must be greater than zero');
      if (requested > totalUsd()) throw new Error(`amount exceeds the fund value (${formatUsd(totalUsd())})`);

      // 現金不夠 → 先按比例賣（session key 簽），再轉出（owner 簽）。
      const shortfall = requested - cash;
      if (shortfall > 0.000001) {
        const redeemed = await redeemPortfolio(token, holding.id, Math.round(shortfall * 1e6) / 1e6);
        if (redeemed.outcome !== 'executed' && redeemed.outcome !== 'noop') {
          throw new Error(`selling the shortfall failed: ${redeemed.reason}`);
        }
      }

      const decimals = usdtRow?.decimals ?? 18;
      const value = parseUnits(requested.toFixed(Math.min(decimals, 6)), decimals);
      const receipt = await sendWithdraw({
        wallet,
        token,
        accountAddress: account as Address,
        asset: usdtAsset as Address,
        recipient: wallet.address as Address,
        amountWei: value,
      });
      if (!receipt.success) throw new Error(`UserOp landed but reverted: ${receipt.txHash}`);
      setWithdrawTx(receipt.txHash);
      await queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) });
      await queryClient.invalidateQueries({ queryKey: ['fund-status', token, holding.id] });
    } catch (cause) {
      setWithdrawError(cause);
    } finally {
      setWithdrawBusy(false);
    }
    }
}

/** 用 owner 錢包把 USDT 轉進 Kernel 帳戶（dev 私鑰或注入錢包都支援）。 */
async function sendUsdt(
  wallet: NonNullable<ReturnType<typeof useOwnerWallet>>,
  token: Address,
  to: Address,
  value: bigint,
): Promise<string> {
  const { createWalletClient, custom, http } = await import('viem');
  const { bsc } = await import('viem/chains');
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, value] });

  if (wallet.kind === 'dev') {
    const rpcUrl = import.meta.env.VITE_RPC_URL ?? (import.meta.env.DEV ? '/rpc' : undefined);
    if (rpcUrl === undefined || rpcUrl === '') throw new Error('dev mode needs VITE_RPC_URL');
    const client = createWalletClient({ account: wallet.account, chain: bsc, transport: http(rpcUrl) });
    return client.sendTransaction({ to: token, data, chain: bsc });
  }
  const client = createWalletClient({ account: wallet.address, chain: bsc, transport: custom(wallet.provider as never) });
  return client.sendTransaction({ to: token, data, chain: bsc });
}

// AssetLogo 目前沒用到（表格用符號），保留 import 會讓 typecheck 失敗，所以標記為已使用。
void AssetLogo;
void Spinner;
