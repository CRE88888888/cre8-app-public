import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { encodeFunctionData, formatEther, formatUnits, parseEther, parseUnits } from 'viem';
import type { Address } from 'viem';
import { closePosition, enrollPortfolio, getAssets, getPortfolioStatus, getPortfolios, listStrategies, postRebalance, redeemPortfolio } from '../../lib/api';
import { CHAIN_ID, approveCalldata, bsc as appChain, readOnlyClient, sendGasTopUp, sendSudoCalls, sendSweep, sendWithdraw } from '../../lib/kernel';
import type { PortfolioStatus } from '../../lib/api';
import { MOCK_FUNDS } from '../../data/mock-funds';
import {safePublicReturn} from '../../lib/public-navigation';
import {useMobile} from '../../lib/use-mobile';
import {ReferenceSheet} from '../reference/ReferenceSheet';
import {catalogueTargets} from '../../data/public-fund-adapter';
import {referenceFund} from '../../lib/public-funds';
import {periodMetrics} from '../../reference/lib/fund-explore';
import {FundOverview} from '../reference/FundOverview';
import { shortAddress } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import { useOwnerWallet } from '../../lib/use-owner-wallet';
import { useSession } from '../../store/session';
import { SignInButton } from '../../components/WalletMenu';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge, ErrorNote, Note, Spinner } from '../../components/ui';
import { AssetLogo } from '../../components/AssetLogo';
import { toast } from '../../components/Toast';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

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
  useBodyClass('vault-page', 'fund-detail-redesign', 'atp-formal-fund', 'atp-complete-fund');
  const { slug } = useParams<{ slug: string }>();
  const token = useSession((state) => state.token);
  const wallet = useOwnerWallet();
  const queryClient = useQueryClient();

  const fund = MOCK_FUNDS.find((entry) => entry.slug === slug);
  const reference = referenceFund(slug ?? '');

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



  // `?tab=withdraw` 直接開提領分頁 —— 分頁狀態本來只在記憶體裡，沒有網址就只能靠手動點。
  const [search,setSearch] = useSearchParams();
  const mobile=useMobile();
  const [mobileTicket,setMobileTicket]=useState(search.get('ticket')==='1'||search.get('tab')==='withdraw');
  const setTicketOpen=(open:boolean)=>{setMobileTicket(open);const next=new URLSearchParams(window.location.search);if(open)next.set('ticket','1');else next.delete('ticket');setSearch(next,{replace:true});};
  // 返回目錄只接受本站路徑，保留篩選但不讓外部網址成為導向目標。
  const requestedReturn = search.get('returnTo');
  const backTo = safePublicReturn(requestedReturn);
  const [tab, setTab] = useState<'deposit' | 'withdraw'>(search.get('tab') === 'withdraw' ? 'withdraw' : 'deposit');
  // 金額**不預填**：任何預設值都是猜的（使用者的餘額、他想存多少，我們都不知道），
  // 而預填超過餘額的數字會讓他一進頁面就看到紅字警告。留空，讓他自己輸入或按 Max。
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // `?facts=1` / `?position=1` 直接開抽屜：客服貼連結給使用者、或營運要截圖核對時用得到。
  const [facts, setFacts] = useState(search.get('facts') === '1');
  const factsTrigger = useRef<HTMLButtonElement>(null);
  // 「My position」＝這個投組的即時狀態（原本在 /portfolios/:id 才能看，現在收進基金頁）。
  const [myPosition, setMyPosition] = useState(search.get('position') === '1');
  const [toppingUp, setToppingUp] = useState(false);
  /** 還沒授權給 executor 的資產（`null` = 還沒讀完）。有錢但沒授權時，UI 必須說出來。 */
  const [unapproved, setUnapproved] = useState<string[] | null>(null);
  const [approving, setApproving] = useState(false);
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

  const live = status.data;

  /**
   * 讀「哪些資產還沒授權給 executor」。
   *
   * 為什麼要獨立成一個 effect：`blocked: ALLOWANCE_TOO_LOW` 是後端在**送交易前**才發現的，
   * 使用者當下看到的是一句看不懂的英文。把這件事提前到畫面上，他才會知道「按這顆按鈕就好」。
   *
   * `null` 代表「還沒讀完」—— 不要用空陣列假裝「都授權好了」，那會讓 UI 在載入中說謊。
   */
  const executorForAllowance = live?.executorAddress ?? null;
  const accountForAllowance = live?.account ?? null;
  const assetRows = live?.drift.assets ?? [];
  /** 用字串當依賴：陣列每次 render 都是新參考，會讓 effect 無限重跑。 */
  const assetKey = assetRows.map((row) => row.asset.toLowerCase()).join(',');
  useEffect(() => {
    if (executorForAllowance === null || accountForAllowance === null || assetKey === '') {
      setUnapproved(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const reader = readOnlyClient();
      const missing = (
        await Promise.all(
          assetRows.map(async (row) => {
            const allowance = await reader
              .readContract({
                address: row.asset as Address,
                abi: ERC20_ABI,
                functionName: 'allowance',
                args: [accountForAllowance as Address, executorForAllowance as Address],
              })
              .catch(() => 0n);
            return allowance > 0n ? null : row.symbol;
          }),
        )
      ).filter((symbol): symbol is string => symbol !== null);
      if (!cancelled) setUnapproved(missing);
    })();
    return () => {
      cancelled = true;
    };
    // assetRows 用 assetKey 代表；其他依賴都是原始值。
  }, [accountForAllowance, assetKey, executorForAllowance]);

  /**
   * 是否**真的持有**這個基金（而不是「有一列投組但裡面是空的」）。
   *
   * 清倉之後帳戶價值 0、持倉 0 檔，但 DB 的 portfolio 列還在。只看 `holding !== undefined` 的話，
   * 「My position」按鈕與那份空持倉表會留在畫面上（實測：清倉後仍顯示 0 資產、drift 5000 bps）——
   * 使用者錢都提出來了，畫面上不該再宣稱他持有。
   */
  const held =
    holding !== undefined &&
    (live === undefined || Number(live.totalUsdE8 ?? '0') > 0 || live.holdings.length > 0);
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

  const rows = live === undefined
    ? (reference?catalogueTargets(reference):fund.holdings).map((row) => ({ symbol: row.symbol, targetBps: row.weightBps, currentBps: null as number | null }))
    : (live.drift.assets ?? []).map((row) => ({ symbol: row.symbol, targetBps: row.targetBps, currentBps: row.currentBps }));


  const ticket = (<>
            <section className="panel ticket" id="ticket">
              {/* Radix Tabs 取代手寫的 role="tablist" + 兩顆 button：拿到鍵盤左右鍵切換、
                  `aria-selected`、`tabIndex` 管理。內容仍是同一個三元式（不改 TabsContent）——
                  那份內容很長，重排只增加 diff 而不增加正確性。 */}
              <Tabs value={tab} onValueChange={(value) => setTab(value as 'deposit' | 'withdraw')}>
                <TabsList className="w-full bg-[var(--card,#eef3f7)]">
                  <TabsTrigger value="deposit" className="flex-1">
                    Deposit
                  </TabsTrigger>
                  <TabsTrigger value="withdraw" className="flex-1">
                    Withdraw
                  </TabsTrigger>
                </TabsList>
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
                ) : (
                  /* 沒有「先 Follow 再 Deposit」這一步 —— 存款就是跟隨。
                     未持有時按 Deposit 會先建帳戶（enroll）再轉 USDT，使用者不必理解 enroll 這個概念。 */
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
                          {usdt?.symbol ?? 'USDT'} →{' '}
                          {holding === undefined
                            ? 'your new account'
                            : shortAddress(holding.smartAccounts[0]?.address ?? '')}
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
                    <ErrorNote error={error} />
                  </form>
                )}
                </div>
              </Tabs>
            </section>


  </>);

  return (
    <>
      <main className="wrap vault-content">
        <div className="vgrid">
          <div className="main">{reference&&<FundOverview key={reference.slug} fund={reference} backTo={backTo} factsTrigger={factsTrigger} onFacts={()=>setFacts(true)} onPosition={()=>setMyPosition(true)} held={held}/>}</div>

          {mobile?<ReferenceSheet open={mobileTicket} onOpenChange={setTicketOpen} title={tab==='deposit'?'Invest':'Withdraw'}>{ticket}</ReferenceSheet>:<aside className="side">{ticket}</aside>}
          <div className="public-mobile-cta"><button className="btn" onClick={()=>{setTab('deposit');setTicketOpen(true);}}>Invest</button><button className="btn ghost" onClick={()=>{setTab('withdraw');setTicketOpen(true);}}>Withdraw</button></div>
        </div>
      </main>


      {/* My position：這個投組的即時狀態。沿用 Fund facts 的抽屜樣式（dialog.pros-drawer）。 */}
      {/*
        為什麼用 shadcn 的 Sheet 而不是自己寫 <dialog>：手寫版只有 Esc 能關，
        沒有 focus trap（Tab 會跑到背後的頁面）、也沒有背景鎖捲動。
        Radix 這些都處理好了，而且保留原本的 .pros-head / .pros-body 內容樣式。
      */}
      <Sheet open={myPosition && live !== undefined} onOpenChange={setMyPosition}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
          <SheetHeader>
            <p className="label">[ My position ]</p>
            <SheetTitle>Portfolio #{live?.portfolioId ?? '—'}</SheetTitle>
          </SheetHeader>
          <div className="pros-body" style={{ padding: '20px 24px' }}>
            {live === undefined ? (
              <p className="fine">No live status for this account yet.</p>
            ) : (
              <>
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
                  <dt>executor approval</dt>
                  <dd>
                    {unapproved === null ? (
                      <span className="muted">checking…</span>
                    ) : unapproved.length === 0 ? (
                      <Badge tone="ok">approved</Badge>
                    ) : (
                      <>
                        <Badge tone="warn">{unapproved.length} asset{unapproved.length === 1 ? '' : 's'} not approved</Badge>
                        <div className="fine neg" style={{ marginTop: 4 }}>
                          The executor cannot pull {unapproved.join(', ')} — a rebalance will be blocked until you
                          approve. Your money is safe; it just cannot be invested.
                        </div>
                        <button
                          type="button"
                          className="btn ghost sm"
                          style={{ marginTop: 6 }}
                          disabled={approving}
                          onClick={() => void approveMissingAssets()}
                        >
                          {approving ? 'Approving…' : `Approve ${unapproved.length} asset${unapproved.length === 1 ? '' : 's'}`}
                        </button>
                      </>
                    )}
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
                        {toppingUp ? 'Topping up…' : 'Top up 0.002 BNB'}
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
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Fund facts：參考站是一個右側抽屜。 */}
      <Sheet open={facts} onOpenChange={setFacts}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl" onCloseAutoFocus={(event) => {
          // 開啟按鈕在頁面標頭，不在 Sheet 內；關閉時明確把焦點還給原入口。
          if (factsTrigger.current !== null) { event.preventDefault(); factsTrigger.current.focus(); }
        }}>
          <SheetHeader>
            <p className="label">[ Fund facts ]</p>
            <SheetTitle>{fund.name}</SheetTitle>
          </SheetHeader>
          <div className="pros-body" style={{ padding: '20px 24px' }}>
            <section className="panel pros-sec">
              <div className="panel-h"><h3>At a glance</h3></div>
              <div className="panel-b"><dl className="kv">
                <dt>Catalogue model</dt><dd>{fund.thesis}</dd>
                <dt>Model rebalancing</dt><dd>{reference?.sourceModel ? 'Source updates' : fund.rebalance === 'none' ? 'No fixed schedule' : fund.rebalance === 'drift' ? 'On allocation drift' : 'Monthly'}</dd>
                <dt>Execution</dt><dd>{strategy === undefined ? 'Example only; no published strategy is connected.' : `Connected to strategy #${strategy.id}. Your account status and execution rules are shown in My position.`}</dd>
              </dl></div>
            </section>
            <section className="panel pros-sec">
              <div className="panel-h"><h3>Performance &amp; data</h3></div>
              <div className="panel-b"><p className="fine">Simulated series copied from the design reference, before fees. It is not this deployment’s result or a forecast. Returns, drawdowns and risk statistics use the selected historical window.</p><dl className="kv"><dt>Since-inception max drop</dt><dd>{reference===undefined?'—':pct((periodMetrics(reference,'ALL').maxDrawdown??0)*100)}</dd></dl></div>
            </section>
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

            <section className="panel vault-creator-card">
              <div className="panel-h">
                <h3>Creator</h3>
              </div>
              <div className="panel-b">
                <p className="vcc-id">
                  <img src="/logos/cre8-icon.svg" alt="" width="32" height="32" />
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
        </SheetContent>
      </Sheet>
    </>
  );

  async function deposit(): Promise<void> {
    if (wallet === null || token === null || strategy === undefined || usdt === undefined) return;
    setBusy(true);
    setError(null);
    const toastId = toast.pending('Deposit', 'Preparing…');
    try {
      // 沒有帳戶就先建（enroll）——「存款就是跟隨」，使用者不必先理解 enroll。
      // 位址是 counterfactual 的：同一個 (owner, strategy) 永遠同一個地址，所以建好之後
      // 之後所有存款都進同一個帳戶。
      let account = holding?.smartAccounts[0]?.address;
      // enroll 後才知道 portfolioId；deposit 結束時要對它跑一輪配置。
      let portfolioIdAfterEnroll: number | null = holding?.id ?? null;
      if (account === undefined) {
        toast.replace(toastId, {
          tone: 'pending',
          title: 'Creating your account',
          body: 'One account per owner and strategy…',
        });
        const created = await enrollPortfolio(token, strategy.id);
        account = created.smartAccounts[0]?.address;
        portfolioIdAfterEnroll = created.id;
        if (account === undefined) throw new Error('the backend returned no smart account address');
        await queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) });
        toast.replace(toastId, { tone: 'pending', title: 'Deposit', body: 'Confirm the transfer in your wallet…' });
      }

      const value = parseUnits(amount === '' ? '0' : amount, usdt.decimals);
      if (value === 0n) throw new Error('amount must be greater than zero');

      // 動錢之前先確認這個帳戶的 gas 夠不夠；不夠就**自動補**。
      //
      // 為什麼：清倉時會把 BNB 掃回錢包（只留 0.003），下一次 deposit 之後再平衡就會碰到
      // 「USDT 進去了、但配置付不出 gas」—— 實測正是這樣：
      //   Send failed: Smart Account does not have sufficient funds
      // 與其讓它進半套，不如在轉 USDT 之前先把 gas 補到位。
      //
      // 只對**已存在的帳戶**：enroll 剛建好的新帳戶 gas 一定是 0，但那是「本來就該補」的情境，
      // 這裡也一併補（一次 top-up 同時覆蓋新帳戶與清倉後的舊帳戶）。
      if (account !== undefined && account !== null) {
        const gas = live?.gas;
        const balance = gas !== null && gas !== undefined && gas.balanceWei !== undefined ? BigInt(gas.balanceWei) : 0n;
        // 最低 gas：後端算的 `minimumWei`，或退而求其次用 0.01 BNB（新帳戶查不到 minimum 時）。
        const minimum =
          gas !== null && gas !== undefined && gas.minimumWei !== undefined ? BigInt(gas.minimumWei) : parseEther('0.002');
        if (balance < minimum) {
          // 補到 minimum + 一小段餘裕（約 1 筆交易的 gas），避免補完立刻又低於門檻。
          // 緩衝只留 0.0005 BNB（約 20 筆 UserOp）—— 原本是 0.01，等於每次補 5 倍的量。
          const topUpWei = minimum - balance + parseEther('0.0005');
          toast.replace(toastId, {
            tone: 'pending',
            title: 'Topping up gas',
            body: `Sending ${Number(formatEther(topUpWei)).toFixed(4)} BNB to the fund's account…`,
          });
          // 這是 owner 錢包 → 帳戶的普通 BNB 轉帳（會再要一次簽名）。
          await sendGasTopUp({ wallet, to: account as Address, valueWei: topUpWei });
          toast.replace(toastId, { tone: 'pending', title: 'Deposit', body: 'Confirm the USDT transfer in your wallet…' });
        }
      }

      const hash = await sendUsdt(wallet, usdt.address as Address, account as Address, value);
      toast.replace(toastId, { tone: 'ok', title: `Deposited ${amount} ${usdt.symbol}`, body: hash });
      setAmount('');

      // 等轉帳**真的被 RPC 看到**再觸發配置。
      //
      // 為什麼：使用者按 Deposit 之後我們立刻呼叫 rebalance，而後端用「目前區塊」讀餘額。
      // 有些 RPC 的 head 會落後一兩個塊（publicnode 實測），於是在 N-1 那個塊上帳戶還是 0 USDT
      // → 規劃器回『Portfolio value is 0 … not sending empty steps』→ 使用者看到
      // 「Deposit recorded (noop)」，錢明明進去了卻沒被配置。
      //
      // 等 2 個確認把「錢在鏈上」與「RPC 看得到它」之間的窗口關掉。
      await waitForConfirmations(hash, 2);

      // 入金後**立刻**跑一輪配置。
      //
      // 為什麼一定要有這一步：排程器只認領 `next_run_at` 已到期的投組，而入金不會調整它 ——
      // 實測剛存完 100 USDT，下一輪是 **23 小時後**，畫面上 drift 9500 bps 卻什麼都不會發生。
      // 「錢進去了卻還是現金」是最容易被誤認為壞掉的行為。
      const target = portfolioIdAfterEnroll;
      if (target !== undefined && target !== null) {
        // ⚠ 一定要把回傳的 id 接住再 replace 它。
        //
        // pending 的 toast **不會自己消失**（那是刻意的：它要等結果）。如果結果用
        // `toast.ok(...)` 另開一則，那個「Configuring your deposit / Buying the target assets…」
        // 就會永遠留在畫面上轉 —— 實測就是這樣：綠色成功訊息淡出後，白色那則還在。
        const configuringId = toast.replace(toastId, {
          tone: 'pending',
          title: 'Configuring your deposit',
          body: 'Buying the target assets…',
        });
        // 先把 executor 授權好，否則第一輪一定被 ALLOWANCE_TOO_LOW 擋下（實測主網首次存款）。
        //
        // 這一步必須由**帳戶擁有者**簽名（approve 不在 session key 的 permit 清單裡，
        // 只有 executeRebalance 是），所以它只能發生在使用者在場的時候 —— 存款正好是那個時刻。
        // 一次 UserOp 打包所有 approve，不是每個資產一個簽名。
        const executorAddress = live?.executorAddress;
        // 只對「還沒授權」的資產送 approve。
        //
        // approve 給的是 max allowance，一次就永久有效 —— 第二次存款開始本來就不該再要簽名。
        // 這裡先讀鏈上 allowance（純讀取、不花錢、不簽名），把已授權過的濾掉。
        const universe = live?.drift.assets ?? [];
        const targets =
          executorAddress === null || executorAddress === undefined || universe.length === 0
            ? []
            : (await Promise.all(
                universe.map(async (row) => {
                  const allowance = await readOnlyClient()
                    .readContract({
                      address: row.asset as Address,
                      abi: ERC20_ABI,
                      functionName: 'allowance',
                      args: [account as Address, executorAddress as Address],
                    })
                    // 讀不到就當沒授權：寧可多簽一次，也不要送出一筆必定 revert 的 rebalance。
                    .catch(() => 0n);
                  return { row, approved: allowance > 0n };
                }),
              ))
                .filter((entry) => !entry.approved)
                .map((entry) => entry.row);

        if (executorAddress !== null && executorAddress !== undefined && targets.length > 0) {
          try {
            toast.replace(configuringId, {
              tone: 'pending',
              title: 'Approving the executor',
              body: `One signature for ${targets.length} asset${targets.length === 1 ? '' : 's'}…`,
            });
            await sendSudoCalls({
              wallet,
              token,
              accountAddress: account as Address,
              strategyId: holding?.strategyId ?? strategy.id,
              calls: targets.map((row) => ({
                to: row.asset as Address,
                data: approveCalldata(executorAddress as Address),
                value: 0n,
              })),
            });
            toast.replace(configuringId, {
              tone: 'pending',
              title: 'Configuring your deposit',
              body: 'Buying the target assets…',
            });
          } catch (cause) {
            // 授權失敗不擋存款本身：錢已經到了，使用者可以再按一次。
            toast.replace(configuringId, {
              tone: 'warn',
              title: 'Deposited, but the approval failed',
              body: (cause as Error).message.split('\n')[0].slice(0, 140),
            });
            throw cause;
          }
        }

        try {
          const round = await postRebalance(token, target);
          // 三種結果要講清楚，因為它們要求使用者做的事完全不同：
          //   executed → 配置完成
          //   blocked  → 被前置檢查擋下（最常見是 allowance），要**再按一次**或先 approve
          //   noop     → 規劃器認為沒事可做（錢沒被看到/已經對齊）
          const tone = round.outcome === 'executed' ? 'ok' : round.outcome === 'blocked' ? 'bad' : 'warn';
          const title =
            round.outcome === 'executed'
              ? 'Deposit configured'
              : round.outcome === 'blocked'
                ? 'Deposited, but the first rebalance was blocked'
                : `Deposited — nothing to configure yet (${round.outcome})`;
          toast.replace(configuringId, {
            tone,
            title,
            body: round.txHash ?? round.reason ?? undefined,
          });
        } catch (cause) {
          // 配置失敗不影響「錢已經到了」：部位還在，排程器之後會處理（或使用者再按一次）。
          toast.replace(configuringId, {
            tone: 'warn',
            title: 'Deposited, but the first rebalance failed',
            body: (cause as Error).message.split('\n')[0].slice(0, 140),
          });
        }
      }
      // 存款後要重抓的是**整條依賴鏈**，不是只有 portfolios：
      //
      //   strategies ──┐
      //                ├──> holding ──> held ──> 「My position」按鈕出不出現
      //   portfolios ──┘
      //
      // 只失效 portfolios 的話，`strategy` 可能還是快取裡那個「這檔基金還沒上鏈」的舊清單，
      // 於是 `holding` 永遠找不到 → 按鈕不出現，**要手動重整才會出現**（實測回報）。
      //
      // `refetchType: 'all'` 連非 active 的查詢一起重抓：`fund-status` 的 queryKey 帶
      // `holding?.id`，在剛 enroll 完的那一輪 render 裡它是 `undefined` 且 `enabled: false` ——
      // 預設只重抓 active 查詢的話，那一筆會被跳過。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategies'], refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' }),
      ]);
    } catch (cause) {
      setError(cause);
      toast.replace(toastId, { tone: 'bad', title: 'Deposit failed', body: (cause as Error).message.split('\n')[0].slice(0, 140) });
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
  /**
   * 只授權「還沒授權」的資產。這顆按鈕存在的理由：
   *
   * `ALLOWANCE_TOO_LOW` 是後端送交易前才發現的，使用者看到的是英文錯誤訊息。
   * 把「你有錢、但 executor 還不能動它」變成畫面上一個明確的狀態 + 一顆按鈕，
   * 他就不必讀懂 allowance 這個字。
   */
  async function approveMissingAssets(): Promise<void> {
    if (wallet === null || token === null || holding === undefined || live === undefined) return;
    const executorAddress = live.executorAddress;
    const accountAddress = live.account;
    if (executorAddress === null || executorAddress === undefined) {
      throw new Error('this deployment has no executor configured');
    }
    const pending = live.drift.assets.filter((row) => unapproved?.includes(row.symbol) === true);
    if (pending.length === 0) return;

    setApproving(true);
    setError(null);
    const id = toast.pending(
      'Approving the executor',
      `One signature for ${pending.length} asset${pending.length === 1 ? '' : 's'}…`,
    );
    try {
      await sendSudoCalls({
        wallet,
        token,
        accountAddress: accountAddress as Address,
        strategyId: holding.strategyId,
        calls: pending.map((row) => ({
          to: row.asset as Address,
          data: approveCalldata(executorAddress as Address),
          value: 0n,
        })),
      });
      toast.replace(id, {
        tone: 'ok',
        title: 'Executor approved',
        body: 'The next rebalance can pull these assets.',
      });
      setUnapproved(null);
      await queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' });
    } catch (cause) {
      toast.replace(id, {
        tone: 'bad',
        title: 'Approval failed',
        body: (cause as Error).message.split('\n')[0].slice(0, 140),
      });
      setError(cause);
    } finally {
      setApproving(false);
    }
  }

  /** 幫帳戶補 gas（owner 錢包轉 BNB 進帳戶，與 portfolio 頁的 top-up 同一條路徑）。 */
  async function topUpGas(): Promise<void> {
    if (wallet === null || token === null || holding === undefined) return;
    const account = holding.smartAccounts[0]?.address;
    if (account === undefined) return;
    setToppingUp(true);
    setError(null);
    try {
      await sendGasTopUp({ wallet, to: account as Address, valueWei: parseEther('0.002') });
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
    const toastId = toast.pending('Closing position', 'Selling every position to USDT…');
    try {
      const sold = await closePosition(token, holding.id);
      if (sold.outcome !== 'executed' && sold.outcome !== 'noop') {
        throw new Error(`closing the position failed: ${sold.reason}`);
      }
      // 賣完重讀餘額：USDT + 所有非零餘額（含賣不掉的塵埃）一起掃回去。
      const fresh = await getPortfolioStatus(token, holding.id);
      const balances = fresh.holdings.map((row) => ({ asset: row.asset as Address, amountWei: BigInt(row.amountWei) }));
      // 連 gas 一起：清倉的語意是「這個帳戶什麼都不剩」。
      // 必須留一點付**這一筆** UserOp 的 gas，否則連驗證都過不了（AA21/AA51）。
      const gasWei = live?.gas?.balanceWei;
      // 掃回時保留的 gas：一筆 sudo UserOp 約 0.000025 BNB，0.0005 是 20 倍餘裕。
      // 原本的 0.003 會讓每次清倉多留 6 倍的錢在帳戶裡。
      const GAS_RESERVE = parseEther('0.0005');
      const nativeWei =
        gasWei === null || gasWei === undefined ? 0n : BigInt(gasWei) > GAS_RESERVE ? BigInt(gasWei) - GAS_RESERVE : 0n;
      const receipt = await sendSweep({
        wallet,
        token,
        accountAddress: account as Address,
        strategyId: holding.strategyId,
        recipient: wallet.address as Address,
        balances,
        nativeWei,
      });
      toast.replace(toastId, { tone: 'pending', title: 'Sending everything back', body: 'Confirm the transfer in your wallet…' });
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
      // 存款後要重抓的是**整條依賴鏈**，不是只有 portfolios：
      //
      //   strategies ──┐
      //                ├──> holding ──> held ──> 「My position」按鈕出不出現
      //   portfolios ──┘
      //
      // 只失效 portfolios 的話，`strategy` 可能還是快取裡那個「這檔基金還沒上鏈」的舊清單，
      // 於是 `holding` 永遠找不到 → 按鈕不出現，**要手動重整才會出現**（實測回報）。
      //
      // `refetchType: 'all'` 連非 active 的查詢一起重抓：`fund-status` 的 queryKey 帶
      // `holding?.id`，在剛 enroll 完的那一輪 render 裡它是 `undefined` 且 `enabled: false` ——
      // 預設只重抓 active 查詢的話，那一筆會被跳過。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategies'], refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' }),
      ]);
      toast.replace(toastId, { tone: 'ok', title: 'Position closed', body: 'Every asset is back in your wallet.' });
    } catch (cause) {
      setWithdrawError(cause);
      toast.replace(toastId, { tone: 'bad', title: 'Close failed', body: (cause as Error).message.split('\n')[0].slice(0, 140) });
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
    const toastId = toast.pending('Withdraw', 'Preparing the round…');
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
        toast.replace(toastId, { tone: 'pending', title: 'Selling positions', body: `Round ${round}: raising ${formatUsd(target)}…` });
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
        strategyId: holding.strategyId,
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
      toast.replace(toastId, { tone: 'ok', title: `Withdrew ${formatUsd(sendable)}`, body: receipt.txHash });
      // 存款後要重抓的是**整條依賴鏈**，不是只有 portfolios：
      //
      //   strategies ──┐
      //                ├──> holding ──> held ──> 「My position」按鈕出不出現
      //   portfolios ──┘
      //
      // 只失效 portfolios 的話，`strategy` 可能還是快取裡那個「這檔基金還沒上鏈」的舊清單，
      // 於是 `holding` 永遠找不到 → 按鈕不出現，**要手動重整才會出現**（實測回報）。
      //
      // `refetchType: 'all'` 連非 active 的查詢一起重抓：`fund-status` 的 queryKey 帶
      // `holding?.id`，在剛 enroll 完的那一輪 render 裡它是 `undefined` 且 `enabled: false` ——
      // 預設只重抓 active 查詢的話，那一筆會被跳過。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategies'], refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' }),
      ]);
    } catch (cause) {
      setWithdrawError(cause);
    } finally {
      setWithdrawBusy(false);
    }
    }
}

/** 用 owner 錢包把 USDT 轉進 Kernel 帳戶（dev 私鑰或注入錢包都支援）。 */
/**
 * 等交易被 **N 個確認**（預設 2）—— 不是只等 receipt。
 *
 * 只等 receipt 的話，我們拿到的「已上鏈」與「RPC 的 head 已經超過那一塊」是兩件事：
 * 後端用 head 讀餘額，head 落後時就看不到剛進來的錢（實測造成 deposit 後的 noop）。
 * 多等一個確認等於替 RPC 留一個塊的追上時間。
 *
 * 用 readOnlyClient（不碰錢包 provider）：這是純讀取，不該經過使用者的錢包。
 */
async function waitForConfirmations(hash: string, confirmations = 2): Promise<void> {
  try {
    await readOnlyClient().waitForTransactionReceipt({ hash: hash as `0x${string}`, confirmations });
  } catch {
    // 等不到也不算失敗：錢已經上鏈了。讓後面的 rebalance 自己去判斷。
  }
}

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
