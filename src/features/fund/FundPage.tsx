import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { encodeFunctionData, formatEther, formatUnits, parseEther, parseUnits } from 'viem';
import type { Address } from 'viem';
import { closePosition, enrollPortfolio, getAssets, getPortfolioStatus, getPortfolios, listStrategies, redeemPortfolio } from '../../lib/api';
import { CHAIN_ID, bsc as appChain, readOnlyClient, sendGasTopUp, sendSweep, sendWithdraw } from '../../lib/kernel';
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
  // 「My position」＝這個投組的即時狀態（原本在 /portfolios/:id 才能看，現在收進基金頁）。
  const [myPosition, setMyPosition] = useState(false);
  const [toppingUp, setToppingUp] = useState(false);
  // 提領：預設 USDT（現金腿），可選帳戶裡任何有餘額的資產 —— 每個都只是一筆 transfer。
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawError, setWithdrawError] = useState<unknown>(null);
  const [withdrawTx, setWithdrawTx] = useState<string | null>(null);
  const [withdrawNote, setWithdrawNote] = useState<string | null>(null);
  /**
   * 錢包（EOA）自己在鏈上的 USDT 餘額。
   *
   * 為什麼一定要顯示：存款失敗時 MetaMask 只會說「This transaction is likely to fail / Network fee
   * Unavailable」，完全看不出是 `BEP20: transfer amount exceeds balance`。實測就是餘額 999 卻要轉 1000。
   */
  const [walletUsdt, setWalletUsdt] = useState<bigint | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [closing, setClosing] = useState(false);

  const walletAddress = wallet?.address ?? null;
  const usdtAddress = usdt?.address;
  const usdtDecimals = usdt?.decimals ?? 18;

  /**
   * 存款金額是否超過錢包餘額。
   *
   * 一定要在送出前擋：超過時鏈上是 `BEP20: transfer amount exceeds balance`，而 MetaMask 只會顯示
   * 「This transaction is likely to fail」＋「Network fee Unavailable」，看不出是餘額問題。
   */
  const depositTooLarge = (() => {
    if (walletUsdt === null) return false;
    try {
      const parsed = parseUnits(amount === '' ? '0' : amount, usdtDecimals);
      return parsed > walletUsdt;
    } catch {
      return false;
    }
  })();
  useEffect(() => {
    if (walletAddress === null || usdtAddress === undefined) {
      setWalletUsdt(null);
      return;
    }
    let cancelled = false;
    void readOnlyClient()
      .readContract({
        address: usdtAddress as Address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletAddress as Address],
      })
      .then((value) => {
        if (!cancelled) setWalletUsdt(value as bigint);
      })
      .catch(() => {
        if (!cancelled) setWalletUsdt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [walletAddress, usdtAddress]);

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
                    {/* 只有持有這個基金時才有「My position」——沒有部位時那顆按鈕只會是空的。 */}
                    {holding === undefined ? null : (
                      <button type="button" className="btn ghost" onClick={() => setMyPosition(true)}>
                        My position
                      </button>
                    )}
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
                  portfolio #{holding?.id} (see “My position” above)
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
                          the “My position” drawer above first.
                        </p>
                      ) : null}
                      {withdrawNote === null ? null : <p className="fine warn">{withdrawNote}</p>}
                      {withdrawTx === null ? null : (
                        <p className="fine">
                          Withdrawn. tx <span className="mono">{withdrawTx}</span>
                        </p>
                      )}
                      <ErrorNote error={withdrawError} />
                      {/* 清倉：把全部部位賣成 USDT，再把 USDT 與所有殘留的股票代幣（塵埃）掃回錢包。 */}
                      <button
                        type="button"
                        className="btn ghost block"
                        disabled={closing || withdrawBusy || wallet === null || totalUsd() === 0}
                        onClick={() => void closeAll()}
                        style={{ marginTop: 8 }}
                        title="Sell everything to USDT, then send the USDT and every leftover token back to your wallet"
                      >
                        {closing ? 'Closing…' : 'Close position'}
                      </button>
                      {totalUsd() === 0 ? (
                        <p className="fine">
                          This account is empty, so there is nothing to withdraw or close — deposit first.
                        </p>
                      ) : null}
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
                          <button type="button" onClick={() => setAmount(maxDepositLabel())}>
                            Max
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
                      {/* ⚠ 只能有**一個** `.swap-sub`：在 ticket 裡它是 grid 的 `sub` 區，
                          兩個元素會被放進同一格而重疊（實測「USDT → your account…」疊在
                          「Wallet balance…」上面，變成看不懂的一行）。所以兩段資訊放進同一個
                          flex 容器，並沿用 CSS 已預期的 `.swap-sub > span` 結構。 */}
                      <span className="swap-sub">
                        <span>
                          {usdt?.symbol ?? 'USDT'} → {shortAddress(holding.smartAccounts[0]?.address ?? '')}
                        </span>
                        <span className="vault-balance-value">
                          · balance{' '}
                          {walletUsdt === null
                            ? '—'
                            : Number(formatUnits(walletUsdt, usdtDecimals)).toLocaleString('en-US', { maximumFractionDigits: 4 })}{' '}
                          {usdt?.symbol ?? 'USDT'}
                        </span>
                      </span>
                      {depositTooLarge ? (
                        <p className="fine neg" style={{ margin: '6px 0 0' }}>
                          That is more than the wallet holds — the transfer would revert with
                          &ldquo;BEP20: transfer amount exceeds balance&rdquo; before it reaches the chain.
                        </p>
                      ) : null}
                    </div>
                    <button type="submit" className="btn primary block" disabled={busy || wallet === null || depositTooLarge}>
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


      {/* My position：這個投組的即時狀態。沿用 Fund facts 的抽屜樣式（dialog.pros-drawer）。 */}
      {myPosition && live !== undefined ? (
        <dialog className="pros-drawer" open aria-labelledby="pos-title">
          <header className="pros-head">
            <div>
              <p className="label">[ My position ]</p>
              <h2 id="pos-title">Portfolio #{live.portfolioId}</h2>
            </div>
            <button type="button" className="pros-x" aria-label="Close my position" onClick={() => setMyPosition(false)}>
              ×
            </button>
          </header>
          <div className="pros-body">
            <section className="panel pros-sec">
              <div className="panel-h">
                <h3>Status</h3>
                <span className="label">block #{live.block}</span>
              </div>
              <div className="panel-b">
                <dl className="kv">
                  <dt>account</dt>
                  <dd className="mono">{live.account}</dd>
                  <dt>total value</dt>
                  <dd>{formatUsd(totalUsd())}</dd>
                  <dt>gross drift</dt>
                  <dd>
                    {live.drift.grossDriftBps} bps / threshold {live.drift.thresholdBps} bps / needs rebalance:{' '}
                    {live.drift.needsRebalance ? 'yes' : 'no'}
                  </dd>
                  <dt>gas</dt>
                  <dd>
                    {live.gas === null || live.gas.balanceWei === null || live.gas.balanceWei === undefined
                      ? 'unknown'
                      : `${Number(formatEther(BigInt(live.gas.balanceWei))).toFixed(6)} BNB`}
                    {wallet === null ? null : (
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={{ marginLeft: 8 }}
                        disabled={toppingUp}
                        onClick={() => void topUpGas()}
                      >
                        {toppingUp ? 'Topping up…' : 'Top up 0.0100 BNB'}
                      </button>
                    )}
                  </dd>
                </dl>
                <ErrorNote error={error} />
              </div>
            </section>

            <section className="panel pros-sec">
              <div className="panel-h">
                <h3>Holdings</h3>
                <span className="label">{live.holdings.length} assets</span>
              </div>
              <div className="panel-b">
                <table className="dk-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th className="num">Target bps</th>
                      <th className="num">Current bps</th>
                      <th className="num">Delta</th>
                      <th className="num">USD value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.drift.assets.map((row) => (
                      <tr key={row.symbol}>
                        <td className="mono">
                          <strong>{row.symbol}</strong>
                        </td>
                        <td className="num">{row.targetBps}</td>
                        <td className="num">{row.currentBps}</td>
                        <td className={`num ${row.deltaBps > 0 ? 'pos' : row.deltaBps < 0 ? 'neg' : ''}`}>
                          {row.deltaBps > 0 ? '+' : ''}
                          {row.deltaBps} bps
                        </td>
                        <td className="num">{formatUsd(Number(row.usdValueE8) / 1e8)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </dialog>
      ) : null}

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

  /**
   * Deposit 的 Max = 錢包 USDT 餘額**向下取整到分**。
   *
   * 寫死 `1000` 的快捷鍵在餘額只有 996 時會直接把表單填成一個「必定 revert」的金額
   * （實測使用者按下去只看到 "That is more than the wallet holds"）。最大值只能向下取。
   */
  function maxDepositLabel(): string {
    if (walletUsdt === null) return '';
    const amount = Number(formatUnits(walletUsdt, usdtDecimals));
    return amount === 0 ? '' : (Math.floor(amount * 100) / 100).toFixed(2);
  }

  /** 整個基金價值（美元）。 */
  function totalUsd(): number {
    return live === undefined || live.totalUsdE8 === null ? 0 : Number(live.totalUsdE8) / 1e8;
  }

  function maxWithdrawLabel(): string {
    return totalUsd() === 0 ? '' : totalUsd().toFixed(2);
  }

  /**
   * 清倉：① 全部賣成 USDT（session key）② 把 USDT 與**所有殘留代幣**掃回錢包（owner 簽）。
   *
   * 為什麼要第二段掃塵埃：賣出有滑價與 wei 級取整，帳戶裡一定會剩一點非 USDT 的渣。
   * 「清倉」的語意是錢包裡什麼都不剩，不是帳戶裡什麼都不剩。
   */
  /** 幫帳戶補 gas（owner 錢包轉 BNB 進帳戶，與 portfolio 頁的 top-up 同一條路徑）。 */
  async function topUpGas(): Promise<void> {
    if (wallet === null || token === null || holding === undefined) return;
    const account = holding.smartAccounts[0]?.address;
    if (account === undefined) return;
    setToppingUp(true);
    setError(null);
    try {
      await sendGasTopUp({ wallet, to: account as Address, valueWei: parseEther('0.01') });
      await queryClient.invalidateQueries({ queryKey: ['fund-status', token, holding.id] });
    } catch (cause) {
      setError(cause);
    } finally {
      setToppingUp(false);
    }
  }

  async function closeAll(): Promise<void> {
    if (wallet === null || token === null || holding === undefined) return;
    const account = holding.smartAccounts[0]?.address;
    if (account === undefined) throw new Error('找不到帳戶');
    setClosing(true);
    setWithdrawError(null);
    setWithdrawTx(null);
    setWithdrawNote(null);
    try {
      const sold = await closePosition(token, holding.id);
      if (sold.outcome !== 'executed' && sold.outcome !== 'noop') {
        throw new Error(`closing the position failed: ${sold.reason}`);
      }
      // 賣完重讀餘額：USDT + 所有非零餘額（含賣不掉的塵埃）一起掃回去。
      const fresh = await getPortfolioStatus(token, holding.id);
      const balances = fresh.holdings.map((row) => ({ asset: row.asset as Address, amountWei: BigInt(row.amountWei) }));
      const receipt = await sendSweep({
        wallet,
        token,
        accountAddress: account as Address,
        recipient: wallet.address as Address,
        balances,
      });
      if (receipt === null) {
        setWithdrawNote('Nothing left to send back — the account is already empty.');
      } else if (!receipt.success) {
        throw new Error(`sweep UserOp landed but reverted: ${receipt.txHash}`);
      } else {
        setWithdrawTx(receipt.txHash);
        setWithdrawNote(
          `Closed: ${sold.steps.length} sell step(s), then ${balances.filter((row) => row.amountWei > 0n).length} token(s) sent back to your wallet.`,
        );
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) });
      await queryClient.invalidateQueries({ queryKey: ['fund-status', token, holding.id] });
    } catch (cause) {
      setWithdrawError(cause);
    } finally {
      setClosing(false);
    }
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
    setWithdrawNote(null);
    try {
      // 錢包不在本 app 的鏈上時，簽名請求會「看起來沒反應」（其實是被鏈切換擋掉）。
      // 明講要切到哪一條，比讓使用者一直按卻沒有彈窗好。
      if (wallet.kind === 'injected') {
        const raw = await (wallet.provider as { request: (a: { method: string }) => Promise<unknown> })
          .request({ method: 'eth_chainId' })
          .catch(() => null);
        const walletChain = typeof raw === 'string' ? Number.parseInt(raw, 16) : null;
        if (walletChain !== null && walletChain !== CHAIN_ID) {
          throw new Error(
            `Your wallet is on chain ${walletChain}; this app needs chain ${CHAIN_ID}. ` +
              `Switch MetaMask to the network that uses RPC http://127.0.0.1:8545 with chain id ${CHAIN_ID}.`,
          );
        }
      }
      if (account === undefined || usdtAsset === undefined) throw new Error('找不到帳戶或會計資產');
      if (!Number.isFinite(requested) || requested <= 0) throw new Error('amount must be greater than zero');
      // ⚠ 不因為「超過總值」丟錯，而是**夾到可提領上限**。
      // 這裡本來是 `throw`，結果 Max 按鈕只要因為四捨五入多填 0.01，使用者就完全無法提領
      // （實測：total 996.0999 → Max 填 996.10 → 直接被自己的驗證擋掉）。
      // 提領自己的錢，多填一點的正確反應是「提出全部」，不是報錯。
      const ceiling = totalUsd();
      const effective = Math.min(requested, ceiling);
      if (requested > ceiling + 1e-6) {
        setWithdrawNote(`Capped to the fund value: ${formatUsd(ceiling)} (you asked for ${formatUsd(requested)}).`);
      }

      // 現金不夠 → 先按比例賣（session key 簽），再轉出（owner 簽）。
      //
      // 賣出量要**放大**：賣掉 $X 的部位不會換到 $X 的 USDT —— 每一條腿都有成本
      // （池費 0.25%、TWAP 地板折扣、價格衝擊）。實測 4 檔賣 $350 只換回 $332（少 5.2%），
      // 於是「提領 400」實際只拿到 381.76。按缺口賣等於系統性少給。
      //
      // 所以：① 按 1/(1−緩衝) 放大 ② 賣完重讀餘額 ③ 還是不夠就再補一輪（最多 2 輪）。
      // 上限 2 輪是刻意的：真的賣不動（流動性不足）時，重試只會燒 gas 而不會變好。
      const SELL_BUFFER = 0.06;
      const MAX_SELL_ROUNDS = 2;
      const readCash = async (): Promise<number> => {
        const fresh = await getPortfolioStatus(token, holding.id);
        const row = (fresh.holdings ?? []).find((entry) => entry.symbol === (usdt?.symbol ?? 'USDT'));
        return row === undefined ? 0 : Number(row.usdValueE8) / 1e8;
      };

      let available = cash;
      for (let round = 1; round <= MAX_SELL_ROUNDS; round += 1) {
        const shortfall = effective - available;
        if (shortfall <= 0.01) break;
        const target = Math.ceil((shortfall / (1 - SELL_BUFFER)) * 1e6) / 1e6;
        const redeemed = await redeemPortfolio(token, holding.id, target);
        if (redeemed.outcome !== 'executed' && redeemed.outcome !== 'noop') {
          throw new Error(`selling the shortfall failed: ${redeemed.reason}`);
        }
        available = await readCash();
        // `noop` 代表連一步都排不出來（沒有可賣的部位）→ 再試也是一樣，直接停。
        if (redeemed.outcome === 'noop') break;
      }

      const sendable = Math.min(effective, available);
      if (sendable <= 0.000001) throw new Error('there is nothing to send after selling');
      const decimals = usdtRow?.decimals ?? 18;
      const value = parseUnits(sendable.toFixed(Math.min(decimals, 6)), decimals);
      const receipt = await sendWithdraw({
        wallet,
        token,
        accountAddress: account as Address,
        asset: usdtAsset as Address,
        recipient: wallet.address as Address,
        amountWei: value,
      });
      if (!receipt.success) throw new Error(`UserOp landed but reverted: ${receipt.txHash}`);
      setWithdrawNote(
        sendable < effective - 0.01
          ? `Sent ${formatUsd(sendable)} of the ${formatUsd(effective)} you asked for — the account ran out of sellable positions (${formatUsd(effective - sendable)} still in stock).`
          : null,
      );
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
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, value] });

  if (wallet.kind === 'dev') {
    const rpcUrl = import.meta.env.VITE_RPC_URL ?? (import.meta.env.DEV ? '/rpc' : undefined);
    if (rpcUrl === undefined || rpcUrl === '') throw new Error('dev mode needs VITE_RPC_URL');
    const client = createWalletClient({ account: wallet.account, chain: appChain, transport: http(rpcUrl) });
    return client.sendTransaction({ to: token, data, chain: appChain });
  }
  const client = createWalletClient({ account: wallet.address, chain: appChain, transport: custom(wallet.provider as never) });
  return client.sendTransaction({ to: token, data, chain: appChain });
}

// AssetLogo 目前沒用到（表格用符號），保留 import 會讓 typecheck 失敗，所以標記為已使用。
void AssetLogo;
void Spinner;
