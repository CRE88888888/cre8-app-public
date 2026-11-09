import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { encodeFunctionData, parseUnits } from 'viem';
import type { Address } from 'viem';
import { getAssets, getPortfolios, listStrategies } from '../../lib/api';
import { MOCK_FUNDS } from '../../data/mock-funds';
import { MOCK_PERFORMANCE } from '../../data/mock-performance';
import { shortAddress } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import { useOwnerWallet } from '../../lib/use-owner-wallet';
import { useSession } from '../../store/session';
import { AssetLogos } from '../../components/AssetLogo';
import { Sparkline } from '../../components/Sparkline';
import { SignInButton } from '../../components/WalletMenu';
import { ErrorNote, Note, Spinner } from '../../components/ui';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

/**
 * 基金頁（參考站的 `/vault/<slug>`）。
 *
 * 這頁有兩個身份，刻意放在同一頁：
 *   1. **目錄頁**：範例基金的介紹、配置、模擬績效（純前端資料，不需要登入或鏈）。
 *   2. **真實策略**：如果鏈上/DB 有一個同名策略（例如 Elon Universe → strategy 529），
 *      就顯示它的真實 mandate，並讓使用者「存 USDT」到**自己的** Kernel 帳戶。
 *
 * 存款的動作很單純：USDT 是 ERC-20，**轉進帳戶就是存款**（帳戶餘額 = 持倉，排程器據此再平衡）。
 * 不需要 approve，也不需要跟我們的合約互動 —— 錢一直在使用者自己的帳戶裡。
 */
export function FundPage(): ReactNode {
  useBodyClass('fund-explore');
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

  // 名稱比對把「範例目錄」接上「真實策略」：Elon Universe → strategy 529。
  const strategy = useMemo(
    () => (fund === undefined ? undefined : (strategies.data?.items ?? []).find((item) => item.name === fund.name)),
    [fund, strategies.data],
  );
  const holding = (portfolios.data ?? []).find((portfolio) => portfolio.strategyId === strategy?.id);
  const usdt = (assets.data ?? []).find((asset) => asset.isNumeraire);

  const [amount, setAmount] = useState('1000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<string | null>(null);

  if (fund === undefined) {
    return (
      <main className="explore-wrap stack">
        <h1>Unknown fund</h1>
        <p className="muted">
          No fund with slug “{slug}”. <Link to="/vaults">Back to funds</Link>.
        </p>
      </main>
    );
  }

  return (
    <main className="explore-wrap">
      <header className="explore-heading">
        <div>
          <p className="eyebrow">
            {fund.kind} · Example fund
          </p>
          <h1>
            {fund.name}
            <span>.</span>
          </h1>
          <p>{fund.thesis}</p>
        </div>
        <div className="explore-heading-actions">
          <Link className="btn btn--ghost" to="/vaults">
            All funds
          </Link>
        </div>
      </header>

      <div className="card stack">
        <dl className="kv">
          <dt>risk</dt>
          <dd>{fund.risk}</dd>
          <dt>rebalance</dt>
          <dd>{fund.rebalance === 'none' ? 'none (buy and hold)' : fund.rebalance === 'drift' ? 'on drift' : 'monthly'}</dd>
          <dt>holdings</dt>
          <dd>
            {fund.holdings.map((entry) => entry.symbol).join(' · ')}
          </dd>
          {performance === undefined ? null : (
            <>
              <dt>simulated return</dt>
              <dd>
                <span className={performance.returnBps >= 0 ? 'pos' : 'neg'}>
                  {performance.returnBps >= 0 ? '+' : '−'}
                  {(Math.abs(performance.returnBps) / 100).toFixed(2)}%
                </span>
                <span className="muted"> since inception · max drop −{(Math.abs(performance.maxDropBps) / 100).toFixed(2)}%</span>
                <span className="fund-row-chart" style={{ display: 'block', maxWidth: 320 }}>
                  <Sparkline points={performance.points} positive={performance.returnBps >= 0} label={`${fund.name} simulated performance`} />
                </span>
              </dd>
            </>
          )}
        </dl>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Simulated performance from the design reference — not a forecast, and not this deployment&apos;s result.
        </p>
      </div>

      {/* ---- 真實策略（如果有同名策略）---- */}
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>On-chain strategy</h2>
          {strategy === undefined ? null : (
            <Link to={`/strategies/${strategy.id}`} style={{ fontSize: 13 }}>
              Strategy #{strategy.id} →
            </Link>
          )}
        </div>

        {/* 查詢錯誤必須看得見：不然「讀不到策略」與「還沒有人上架」在畫面上完全一樣。 */}
        <ErrorNote error={strategies.error} />
        {strategies.error !== null && strategies.error !== undefined ? null : token === null ? (
          <Note tone="warn">
            <SignInButton /> to see the live strategy and deposit.
          </Note>
        ) : strategies.isPending ? (
          <div className="row">
            <Spinner /> <span className="muted">Loading strategies…</span>
          </div>
        ) : strategy === undefined ? (
          <Note>
            This fund exists only as an example in the catalogue — nobody has published it on-chain yet, so there is
            nothing to deposit into. An operator publishes a real strategy from the whitelist, and this panel then
            shows its live mandate and a deposit box.
          </Note>
        ) : (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Published on-chain as strategy #{strategy.id}
              {strategy.onchainId === null ? '' : ` (registry id ${strategy.onchainId})`}. {strategy.description}
            </p>

            <div className="fund-row-assets">
              <AssetLogos
                symbols={(assets.data ?? [])
                  .filter((asset) => fund.holdings.some((holdingRow) => holdingRow.symbol === asset.symbol))
                  .map((asset) => asset.symbol)}
              />
            </div>

            {holding === undefined ? (
              <Note tone="warn">
                You do not follow this strategy yet. Create a fund from the <Link to="/create">create page</Link> to
                get your own smart account for it — every follower gets a separate account.
              </Note>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Your account for this strategy: <span className="mono">{shortAddress(holding.smartAccounts[0]?.address ?? '')}</span>{' '}
                  · <Link to={`/portfolios/${holding.id}`}>open portfolio #{holding.id}</Link>
                </p>
              </div>
            )}

            {/* ---- 存 USDT ---- */}
            <div className="stack" style={{ gap: 8, marginTop: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Deposit USDT</h3>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                USDT is an ERC-20: depositing means <strong>transferring it to your own smart account</strong>. No
                approval, no contract call — the account holds the tokens, and the scheduler rebalances them toward
                the mandate.
              </p>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  style={{ width: 140 }}
                  aria-label="USDT amount"
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy || wallet === null || holding === undefined || usdt === undefined}
                  title={
                    wallet === null
                      ? 'connect the owner wallet'
                      : holding === undefined
                        ? 'create your account for this strategy first'
                        : undefined
                  }
                  onClick={() => void deposit()}
                >
                  {busy ? 'Sending…' : 'Deposit'}
                </button>
                {wallet === null ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    connect the owner wallet
                  </span>
                ) : holding === undefined ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    you need an account for this strategy first
                  </span>
                ) : null}
              </div>
              {sent === null ? null : (
                <p className="pos" style={{ margin: 0, fontSize: 12 }}>
                  Deposited. tx <span className="mono">{sent}</span>
                </p>
              )}
              <ErrorNote error={error} />
            </div>
          </>
        )}
      </div>
    </main>
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
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
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

/** 讀 USDT 餘額（顯示用；失敗就回 null，不讓它擋住頁面）。 */
export function useUsdtBalance(address: string | null, token: string | undefined): bigint | null {
  const [balance, setBalance] = useState<bigint | null>(null);
  useEffect(() => {
    if (address === null || token === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const { createPublicClient, http } = await import('viem');
        const { bsc } = await import('viem/chains');
        const rpcUrl = import.meta.env.VITE_RPC_URL ?? (import.meta.env.DEV ? '/rpc' : undefined);
        if (rpcUrl === undefined || rpcUrl === '') return;
        const client = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
        const value = (await client.readContract({
          address: token as Address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address as Address],
        })) as bigint;
        if (!cancelled) setBalance(value);
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, token]);
  return balance;
}

