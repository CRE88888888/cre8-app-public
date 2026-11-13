import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, createStrategy, enrollPortfolio, getAssets, getPortfolioStatus, publishVersion } from '../../lib/api';
import { approveCalldata, sendGasTopUp, sendSudoCalls } from '../../lib/kernel';
import type { RenewalWallet } from '../../lib/kernel';
import { useWallet } from '../../store/wallet';
import type { PriceableAsset } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import {savedActivationDesign} from '../../lib/activation-design';
import { useSession } from '../../store/session';
import { SignInButton } from '../../components/WalletMenu';
import { ErrorNote, Note, Spinner } from '../../components/ui';
import { AssetLogo } from '../../components/AssetLogo';
import { assetBySymbol } from '../../lib/public-funds';

/** Rebalance cadence. The backend requires `intervalSeconds >= 60`; one hour is the shortest sensible cadence. */
const INTERVALS = [
  { label: 'Hourly', seconds: 3600 },
  { label: 'Every 6h', seconds: 21_600 },
  { label: 'Daily', seconds: 86_400 },
] as const;

type Step =
  | 'idle'
  | 'creating-strategy'
  | 'publishing-version'
  | 'enrolling'
  | 'topping-up-gas'
  | 'approving'
  | 'done';

const STEP_LABEL: Record<Exclude<Step, 'idle' | 'done'>, string> = {
  'creating-strategy': 'Creating the strategy (mirrors to the on-chain registry)…',
  'publishing-version': 'Publishing the version (weights + schedule)…',
  enrolling: 'Deploying the smart account (enroll)…',
  'topping-up-gas': 'Sending gas to the new account and waiting for it to arrive…',
  approving: 'Signing the approval (one wallet signature)…',
};

/**
 * Create fund — **one strategy only: a target-weight index fund**.
 *
 * The design mock offers Buy & hold, Stack and Pair grid templates. Our backend has no execution path for
 * them, so this page does not pretend otherwise: it turns "assets + weights + cadence" into
 * `strategy` → `version` → `portfolio`, three real resources.
 *
 * Steps 1 and 3 send on-chain transactions, so progress is shown step by step — a spinner that says
 * nothing for 30 seconds makes people press the button again.
 */
export function ActivateFundPage(): ReactNode {
  // The design's create page carries its own body class (`.create-page { background: var(--panel) }`).
  useBodyClass('create-page');
  const token = useSession((state) => state.token);
  const walletState = useWallet();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const renewalWallet: RenewalWallet | null =
    walletState.kind === 'injected' && walletState.provider !== null && walletState.address !== null
      ? { kind: 'injected', address: walletState.address as `0x${string}`, provider: walletState.provider }
      : walletState.kind === 'dev' && walletState.devSigner !== null
        ? { kind: 'dev', address: walletState.devSigner.address as `0x${string}`, account: walletState.devSigner.account }
        : null;

  const [draft] = useState(savedActivationDesign);
  const [allocationAgreed,setAllocationAgreed]=useState(false);
  const [name, setName] = useState(draft?.name||'');
  const [description, setDescription] = useState('');
  const [weights, setWeights] = useState<Record<string, number>>(draft?.weights||{});
  const [intervalSeconds, setIntervalSeconds] = useState<number>(3600);
  const [step, setStep] = useState<Step>('idle');
  /**
   * 同步的「已有請求在飛」旗標。
   *
   * `step` 是 React state，要等到下一次 render 才會反映；**連點兩下會在兩次 render 之間送出兩個請求** ——
   * 實際發生過：13 秒內建立了兩個一模一樣的策略與帳戶（#1599、#1600），各鏡像到鏈上、各部署一個
   * smart account。`useRef` 的值是同步寫入的，所以第二下點擊進不來。
   */
  const inFlight = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ strategyId: number; portfolioId: number } | null>(null);
  const [approval, setApproval] = useState<{ tx: string | null; error: unknown } | null>(null);

  const assets = useQuery({
    queryKey: ['assets', token],
    queryFn: () => getAssets(token as string),
    enabled: token !== null,
    staleTime: 60_000,
  });

  const selected = useMemo(() => Object.entries(weights).filter(([, percent]) => percent > 0), [weights]);
  /** Accumulate in bps, not floating percentages: `33.3 + 33.3 + 33.4` is not 100 in binary floating point. */
  const totalBps = selected.reduce((sum, [, percent]) => sum + Math.round(percent * 100), 0);
  const unavailableAssets=selected.filter(([address])=>!assets.data?.some(asset=>asset.address.toLowerCase()===address.toLowerCase()&&asset.tradable!==false));
  const valid = name.trim().length > 0 && totalBps === 10_000 && unavailableAssets.length===0 && (draft===null||allocationAgreed);
  const busy = step !== 'idle' && step !== 'done';

  const toggle = (asset: PriceableAsset): void => {
    setWeights((current) => {
      const next = { ...current };
      if (next[asset.address.toLowerCase()] === undefined) next[asset.address.toLowerCase()] = 0;
      else delete next[asset.address.toLowerCase()];
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (token === null || !valid) return;
    // 同步守衛：連點的第二下會在這裡被擋掉（state 還沒 re-render，按鈕也還沒 disabled）。
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setCreated(null);
    try {
      setStep('creating-strategy');
      const strategy = await createStrategy(token, {
        name: name.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      });

      setStep('publishing-version');
      await publishVersion(token, strategy.id, {
        allocation: {
          assets: selected.map(([address, percent]) => ({
            address,
            weightBps: Math.round(percent * 100),
          })),
        },
        schedule: { kind: 'interval', intervalSeconds },
        changeLog: 'created from the app',
      });

      setStep('enrolling');
      const portfolio = await enrollPortfolio(token, strategy.id);

      /**
       * 建立完就**順手把 approve 做完**，這樣「決定好資產與策略」之後只需要一次錢包簽名，
       * 而不是事後還要記得去按一次 Approve。
       *
       * 兩件事依序發生，而且都會出現在進度上：
       *   1. 帳戶沒有 BNB 時先轉 gas（approve 那筆 op 由帳戶自己付 gas）
       *   2. owner 簽一筆 sudo UserOp，對每個策略資產 approve 給 executor
       *
       * 失敗不讓建立失敗 —— 投組已經上鏈了。錯誤會留在畫面上，Allowance 卡片可以重試。
       */
      let approval: { tx: string | null; error: unknown } = { tx: null, error: null };
      if (renewalWallet !== null) {
        try {
          const status = await getPortfolioStatus(token, portfolio.id);
          const executor = status.executorAddress;
          if (executor !== null) {
            const shortfall = BigInt(portfolio.gas?.shortfallWei ?? '0');
            if (shortfall > 0n) {
              setStep('topping-up-gas');
              // `sendGasTopUp` 會等轉帳上鏈才回來：下面的 approve UserOp 要靠這筆 BNB 付 gas（cre8-app#22）。
              await sendGasTopUp({ wallet: renewalWallet, to: status.account as `0x${string}`, valueWei: shortfall });
            }
            setStep('approving');
            const receipt = await sendSudoCalls({
              wallet: renewalWallet,
              token,
              accountAddress: status.account as `0x${string}`,
              strategyId: strategy.id,
              calls: status.targets.map((target) => ({
                to: target.asset as `0x${string}`,
                data: approveCalldata(executor as `0x${string}`),
                value: 0n,
              })),
            });
            approval = { tx: receipt.txHash, error: null };
          }
        } catch (cause) {
          approval = { tx: null, error: cause };
        }
      }
      setApproval(approval);

      setCreated({ strategyId: strategy.id, portfolioId: portfolio.id });
      setStep('done');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) }),
        queryClient.invalidateQueries({ queryKey: ['assets', token] }),
      ]);
    } catch (cause) {
      setError(cause);
      setStep('idle');
    } finally {
      inFlight.current = false;
    }
  };

  if (token === null) {
    return (
      // 沒登入時不再只丟一行「Sign in first」：設計基金不需要錢包，先讓人動手；已經有配置的人再連錢包。
      <main className="explore-wrap app-portfolio app-studio">
        <section className="app-portfolio-summary app-portfolio-guest create-guest" aria-labelledby="create-guest-title">
          <h2 id="create-guest-title">Create a fund</h2>
          <p>
            Pick the assets and weights first. You only need a wallet when you activate it:
            that step creates the strategy and a smart account under your wallet.
          </p>
          <ol className="create-steps">
            <li><b>1</b>Design the allocation</li>
            <li><b>2</b>Connect and sign in</li>
            <li><b>3</b>Activate on-chain</li>
          </ol>
          <Link className="btn primary" to="/create">Design a fund</Link>
          <span className="create-guest-alt">Already have an allocation? <SignInButton /></span>
        </section>
      </main>
    );
  }

  /** 百分比顯示：最多兩位小數，去掉多餘的 0（60.00 → 60、12.50 → 12.5）。 */
  const tidy = (value: number): string => value.toFixed(2).replace(/\.?0+$/, '');
  const cadenceLabel = INTERVALS.find((option) => option.seconds === intervalSeconds)?.label ?? `${intervalSeconds}s`;
  const symbolFor = (address: string): string =>
    assets.data?.find((asset) => asset.address.toLowerCase() === address.toLowerCase())?.symbol ?? draft?.symbols[address] ?? address;
  /** 已勾選的資產平均分配，合計剛好 100%（餘數給第一個）。只改畫面上的權重，送出的流程不變。 */
  const splitEvenly = (): void => {
    setWeights((current) => {
      const picked = Object.keys(current);
      if (picked.length === 0) return current;
      const share = Math.floor(10_000 / picked.length);
      const next: Record<string, number> = {};
      picked.forEach((address, index) => {
        next[address] = (share + (index === 0 ? 10_000 - share * picked.length : 0)) / 100;
      });
      return next;
    });
  };
  const pickedCount = Object.keys(weights).length;
  const totalPercent = totalBps / 100;
  // 按鈕旁只說「還差什麼」，一次一件：比一句「需要名稱與剛好 100%」好找到下一步。
  const missing = name.trim() === ''
    ? 'Give your fund a name'
    : pickedCount === 0
      ? 'Pick at least one asset'
      : totalBps < 10_000
        ? `Weights add up to ${tidy(totalPercent)}%. ${tidy(((10_000 - totalBps) / 100))}% to go`
        : totalBps > 10_000
          ? `Weights add up to ${tidy(totalPercent)}%. Remove ${tidy(((totalBps - 10_000) / 100))}%`
          : unavailableAssets.length > 0
            ? 'Remove the assets that are not available'
            : draft !== null && !allocationAgreed
              ? 'Confirm the allocation from your design'
              : null;

  return (
    <main className="explore-wrap cf">
      <header className="explore-heading cf-head">
        <div>
          <h1>Activate a fund<span>.</span></h1>
          <p>Pick the assets and set their weights. CRE8 trades through USDT to keep them there.</p>
        </div>
        <Link className="cf-design-link" to="/create">Open the full designer <span aria-hidden="true">→</span></Link>
      </header>

      <div className="cf-grid">
        <div className="cf-form">
          {draft && (
            <section className="cf-block cf-draft">
              <h2>Allocation from your design</h2>
              <p>Activate these holdings as a target-weight strategy. Choose the rebalance interval below. Other design rules and fee settings remain in your exported design.</p>
              <label className="cf-confirm">
                <input type="checkbox" checked={allocationAgreed} onChange={(event) => setAllocationAgreed(event.target.checked)} />
                I want to activate this allocation as a target-weight strategy.
              </label>
              {assets.data && unavailableAssets.length > 0 && (
                <div className="cf-unavailable">
                  <p>These assets are unavailable for activation:</p>
                  {unavailableAssets.map(([address]) => (
                    <p key={address}>
                      {draft.symbols[address] || address}{' '}
                      <button type="button" className="btn ghost sm" onClick={() => setWeights((current) => { const next = { ...current }; delete next[address]; return next; })}>Remove</button>
                    </p>
                  ))}
                  <p>Review the remaining weights before continuing.</p>
                </div>
              )}
              <Link to="/create">← Back to fund design</Link>
            </section>
          )}

          <section className="cf-block">
            <h2><b>1</b>Name it</h2>
            <label className="field cf-field">
              <span>Fund name</span>
              <input
                id="fund-name"
                value={name}
                maxLength={120}
                placeholder="BNB Ecosystem Balanced"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field cf-field">
              <span>One-line thesis <em>Optional</em></span>
              <input
                id="fund-desc"
                value={description}
                maxLength={500}
                placeholder="Why these assets, in one sentence"
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </section>

          <section className="cf-block">
            <div className="cf-block-head">
              <h2><b>2</b>Pick assets and weights</h2>
              {pickedCount > 1 && (
                <button type="button" className="btn ghost sm" onClick={splitEvenly}>Split evenly</button>
              )}
            </div>

            {assets.isPending ? (
              <div className="row">
                <Spinner /> <span className="muted">Loading assets…</span>
              </div>
            ) : assets.error !== null && assets.error !== undefined ? (
              <ErrorNote error={assets.error} />
            ) : assets.data === undefined ? null : assets.data.length === 0 ? (
              <Note tone="warn">No assets are available yet. Tokens have to be added before a fund can be created.</Note>
            ) : (
              <ul className="cf-assets" role="list">
                {assets.data.map((asset) => {
                  const key = asset.address.toLowerCase();
                  const isOn = weights[key] !== undefined;
                  // `tradable === false` = router 沒有這個資產的 oracle：選了會建出一個永遠執行不了的策略
                  // （第一次再平衡才以 OracleNotSet 失敗）。null = 查不到，允許但標示未知。
                  const blocked = asset.tradable === false;
                  const known = assetBySymbol(asset.symbol);
                  return (
                    <li key={asset.address} className={`cf-asset${isOn ? ' is-on' : ''}${blocked ? ' is-blocked' : ''}`}>
                      <label className="cf-asset-pick" title={asset.address}>
                        <input
                          type="checkbox"
                          checked={isOn}
                          disabled={blocked}
                          aria-label={`Select ${asset.symbol}`}
                          onChange={() => toggle(asset)}
                        />
                        <span className="cf-asset-logo"><AssetLogo symbol={asset.symbol} /></span>
                        <span className="cf-asset-name">
                          <strong>{known?.symbol ?? asset.symbol}</strong>
                          <small>
                            {blocked
                              ? 'Not tradable yet'
                              : asset.isNumeraire
                                ? 'Cash held in the fund'
                                : known?.name ?? `${asset.address.slice(0, 6)}…${asset.address.slice(-4)}`}
                            {asset.tradable === null ? ' · availability unknown' : ''}
                          </small>
                        </span>
                      </label>
                      {isOn && (
                        <span className="cf-weight">
                          <input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={100}
                            step={0.01}
                            aria-label={`${asset.symbol} weight in percent`}
                            value={weights[key] ?? 0}
                            onChange={(event) => {
                              const percent = Number(event.target.value);
                              setWeights((current) => ({
                                ...current,
                                [key]: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
                              }));
                            }}
                          />
                          <i aria-hidden="true">%</i>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {pickedCount > 0 && (
              <div className="cf-total" data-state={totalBps === 10_000 ? 'ok' : totalBps > 10_000 ? 'over' : 'under'} role="status">
                <span className="cf-total-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, totalPercent)}%` }} /></span>
                <strong>{tidy(totalPercent)}%</strong>
                <span>
                  {totalBps === 10_000
                    ? 'Fully allocated'
                    : totalBps > 10_000
                      ? `${tidy(((totalBps - 10_000) / 100))}% over`
                      : `${tidy(((10_000 - totalBps) / 100))}% left to allocate`}
                </span>
              </div>
            )}

            {assets.data !== undefined && assets.data.some((asset) => asset.tradable === false) ? (
              <Note tone="warn">
                Assets marked <strong>Not tradable yet</strong> can&apos;t be bought or sold on CRE8 right now, so they are
                switched off here. A fund that holds them could never rebalance.
              </Note>
            ) : null}
          </section>

          <section className="cf-block">
            <h2><b>3</b>How often to rebalance</h2>
            <div className="seg public-periods cf-cadence" role="group" aria-label="Rebalance cadence">
              {INTERVALS.map((option) => (
                <button
                  key={option.seconds}
                  type="button"
                  className={intervalSeconds === option.seconds ? 'on' : ''}
                  aria-pressed={intervalSeconds === option.seconds}
                  onClick={() => setIntervalSeconds(option.seconds)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="cf-help">
              CRE8 checks the weights on this schedule. It only trades when they have drifted past the threshold, and each
              trade is capped by the price-impact budget.
            </p>
          </section>
        </div>

        <aside className="cf-side">
          <section className="cf-summary" aria-label="Your fund">
            <span className="cf-summary-label">Your fund</span>
            <strong className={`cf-summary-name${name.trim() === '' ? ' is-empty' : ''}`}>{name.trim() === '' ? 'Untitled fund' : name.trim()}</strong>

            {selected.length > 0 ? (
              <>
                <span className="snap-bar" aria-hidden="true">
                  {[...selected].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([address, percent]) => <i key={address} style={{ flexGrow: percent }} />)}
                </span>
                <ul className="cf-summary-list" role="list">
                  {[...selected].sort((x, y) => y[1] - x[1]).map(([address, percent]) => (
                    <li key={address}><span>{symbolFor(address)}</span><b>{tidy(percent)}%</b></li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="cf-summary-empty">Your allocation shows up here as you pick assets.</p>
            )}

            <dl className="cf-summary-facts">
              <dt>Rebalance</dt>
              <dd>{cadenceLabel}</dd>
            </dl>

            {step !== 'idle' && step !== 'done' ? (
              <Note>
                <div className="row">
                  <Spinner /> <strong>{STEP_LABEL[step]}</strong>
                </div>
                <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
                  Step 1 mirrors the strategy to the on-chain registry and step 3 deploys the smart account — both cost gas
                  and take time. This is not stuck.
                </p>
              </Note>
            ) : null}

            <button type="button" className="btn btn--primary cf-submit" disabled={!valid || busy} onClick={() => void submit()}>
              {busy ? 'Creating…' : 'Create fund'}
            </button>
            {!valid && missing !== null && <p className="cf-missing">{missing}</p>}
            {valid && !busy && created === null && (
              <p className="cf-missing">Your wallet will ask you to confirm. Creating a fund costs gas.</p>
            )}

            <ErrorNote error={error} />
            {error instanceof ApiError && error.code === 'CHAIN_NOT_CONFIGURED' ? (
              <Note tone="warn">
                The backend has no chain configured (`RPC_URL` / `OPERATOR_PRIVATE_KEY`). Creating a strategy mirrors it to
                the on-chain registry, so it fails here without that.
              </Note>
            ) : null}

            {created === null ? null : (
              <Note>
                <strong>Created</strong>
                <div style={{ marginTop: 6 }}>
                  Strategy #{created.strategyId} · portfolio #{created.portfolioId}
                </div>
                {approval === null ? null : approval.error !== null ? (
                  <div style={{ marginTop: 8 }}>
                    <Note tone="warn">
                      Fund created, but the approval did not go through. The account cannot rebalance until it is
                      approved — open the portfolio and use the Allowance section to retry.
                    </Note>
                    <ErrorNote error={approval.error} />
                  </div>
                ) : (
                  <div style={{ marginTop: 8, fontSize: 13 }}>
                    Assets approved for the executor{' '}
                    <span className="mono">({approval.tx?.slice(0, 12)}…)</span>
                  </div>
                )}
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => navigate('/studio/funds')}
                  >
                    See it in My funds
                  </button>
                  <Link className="btn btn--sm btn--ghost" to="/portfolios">
                    Open the portfolio
                  </Link>
                </div>
              </Note>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
