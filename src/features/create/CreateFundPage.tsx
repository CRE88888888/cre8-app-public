import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, createStrategy, enrollPortfolio, getAssets, getPortfolioStatus, publishVersion } from '../../lib/api';
import { CHAIN, approveCalldata, sendGasTopUp, sendSudoCalls } from '../../lib/kernel';
import type { RenewalWallet } from '../../lib/kernel';
import { useWallet } from '../../store/wallet';
import type { PriceableAsset } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import {savedActivationDesign} from '../../lib/activation-design';
import { useSession } from '../../store/session';
import { SignInButton, openWalletMenu } from '../../components/WalletMenu';
import { PRIVY_ENABLED } from '../../lib/privy-config';
import { signInCopy } from '../../lib/sign-in-reason';
import { openSignIn, usePrivyAuth } from '../../store/privy';
import { ErrorNote, Note, Spinner } from '../../components/ui';
import { AssetLogo } from '../../components/AssetLogo';
import { assetBySymbol } from '../../lib/public-funds';
import { EXECUTION_COPY, executionConfirm, minimumDeposit, stackWords, typedVersionBody, type AssetExecution, type ExecutionKind } from '../../lib/fund-execution';
import { featureLock } from '../../lib/feature-flags';
import { FeatureBadge } from '../../components/FeatureLock';

/** 主網 USDT。後端的資產清單會回報這條鏈真正的計價幣（`isNumeraire`），拿不到時才用這個。 */
const MAINNET_USDT = '0x55d398326f99059ff775485246999027b3197955';
const HOLD: AssetExecution = { kind: 'hold' };

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
  'publishing-version': 'Publishing the version (weights and how it runs)…',
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
  /**
   * 設計好基金、按了建立才到這一頁，卻還沒登入：這就是「要建立的那一刻」，直接給整頁的登入頁
   * （Privy 模式）。只自動出現一次；按了「Not now」就留在下面那一頁，可以再按一次或回去改設計。
   * 等 Privy 確定沒有人登入才開：剛從 Google 轉回來時 token 還在換，那時不該再跳一次登入頁。
   */
  const privyPhase = usePrivyAuth((state) => state.phase);
  const askedToSignIn = useRef(false);
  useEffect(() => {
    if (!PRIVY_ENABLED || token !== null || draft === null || privyPhase !== 'signed-out' || askedToSignIn.current) return;
    askedToSignIn.current = true;
    openSignIn({ purpose: 'create' });
  }, [token, draft, privyPhase]);
  const [allocationAgreed,setAllocationAgreed]=useState(false);
  const [name, setName] = useState(draft?.name||'');
  const [description, setDescription] = useState('');
  const [weights, setWeights] = useState<Record<string, number>>(draft?.weights||{});
  /**
   * 每個資產各自的策略（docs#57 G0-4）：從設計器來的草稿帶著每個資產的設定（Stack 的排程由創作者在設計器設）；
   * 換不了（還沒開放的策略、排程不對）就回設計器改，這裡不替它選。快速設定沒有草稿：每個資產都是 Buy & hold。
   */
  const [kindAgreed, setKindAgreed] = useState(false);
  /**
   * 失敗後重試：策略已經建好（名稱沒改）就沿用，從發版或 enroll 接著做，不再建第二個策略。
   * 同一份設定重發，後端讀回原版本（BE-1 的冪等規則）。
   */
  const createdStrategy = useRef<{ id: number; name: string } | null>(null);
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
  const usdt = (assets.data?.find((asset) => asset.isNumeraire)?.address ?? CHAIN.contracts?.usdt ?? MAINNET_USDT).toLowerCase();
  /** 這個資產怎麼買：草稿裡的設定，沒有就是 Buy & hold。USDT 是現金，不買。 */
  const executionOf = (address: string): AssetExecution => draft?.executions?.[address.toLowerCase()] ?? HOLD;
  const invested = selected.filter(([address]) => address.toLowerCase() !== usdt);
  const kinds = new Set<ExecutionKind>(invested.map(([address]) => executionOf(address).kind));
  const draftProblem = draft?.executionProblem ?? null;
  const valid = name.trim().length > 0 && totalBps === 10_000 && unavailableAssets.length===0 && (draft===null||allocationAgreed)
    && draftProblem === null && kindAgreed;
  const idleLock = featureLock('idleYield');
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
      // 先組好要發的版本：組不出來（權重不對、同一資產兩次）就不建策略。
      const version = typedVersionBody({
        chainId: CHAIN.id,
        usdt,
        assets: selected.map(([address, percent]) => ({
          address,
          weightBps: Math.round(percent * 100),
          ...(address.toLowerCase() === usdt ? {} : { execution: executionOf(address) }),
        })),
        changeLog: 'created from the app',
      });
      const trimmed = name.trim();
      let strategy = createdStrategy.current?.name === trimmed ? { id: createdStrategy.current.id } : null;
      if (strategy === null) {
        setStep('creating-strategy');
        const made = await createStrategy(token, {
          name: trimmed,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
        });
        createdStrategy.current = { id: made.id, name: trimmed };
        strategy = { id: made.id };
      }

      setStep('publishing-version');
      await publishVersion(token, strategy.id, version);

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
            // 代付的鏈（測試網）不補 gas：帳戶的 UserOp 由平台付（cre8-app#62）。
            if (shortfall > 0n && !CHAIN.sponsored) {
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

      createdStrategy.current = null;
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

  if (token === null && draft !== null) {
    return (
      // 已經設計好了，只差登入：不要再叫人「先去設計」。
      <main className="explore-wrap app-portfolio app-studio">
        <section className="app-portfolio-summary app-portfolio-guest create-guest" aria-labelledby="create-guest-title">
          <h2 id="create-guest-title">Your fund is ready to create</h2>
          <p>
            {draft.name ? <><b>{draft.name}</b> is saved on this device. </> : 'Your design is saved on this device. '}
            Sign in to create it: that step creates the strategy and a smart account under your wallet.
          </p>
          <button type="button" className="btn primary" onClick={() => openWalletMenu({ purpose: 'create' })}>
            {signInCopy({ purpose: 'create' }).button}
          </button>
          <span className="create-guest-alt"><Link className="link-button" to="/create">Back to the design</Link></span>
        </section>
      </main>
    );
  }

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
            : draftProblem !== null
              ? 'Change your design first'
              : draft !== null && !allocationAgreed
                ? 'Confirm the allocation from your design'
                : !kindAgreed
                  ? 'Confirm how each asset is bought'
                  : null;

  return (
    <main className="explore-wrap cf">
      <header className="explore-heading cf-head">
        <div>
          <h1>Activate a fund<span>.</span></h1>
          <p>Pick the assets and their weights, then confirm how each one is bought.</p>
        </div>
        <Link className="cf-design-link" to="/create">Open the full designer <span aria-hidden="true">→</span></Link>
      </header>

      <div className="cf-grid">
        <div className="cf-form">
          {draft && (
            <section className="cf-block cf-draft">
              <h2>Allocation from your design</h2>
              {draftProblem !== null ? (
                <Note tone="warn">{draftProblem} <Link to="/create">Change it in the designer →</Link></Note>
              ) : (
                <p>Activate these holdings with the strategy each asset has in your design. Fee settings and anything still marked Coming soon stay in your design.</p>
              )}
              <label className="cf-confirm">
                <input type="checkbox" checked={allocationAgreed} disabled={draftProblem !== null} onChange={(event) => setAllocationAgreed(event.target.checked)} />
                I want to activate this allocation.
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
            <h2><b>3</b>How it buys</h2>
            {invested.length === 0 ? (
              <p className="cf-help">Pick an asset to see how it is bought. USDT stays as cash.</p>
            ) : (
              <ul className="cf-summary-list" role="list" aria-label="How each asset is bought">
                {invested.map(([address]) => {
                  const execution = executionOf(address);
                  return (
                    <li key={address}>
                      <span>{symbolFor(address)}</span>
                      <b>{draftProblem !== null ? '—' : execution.kind === 'stack' ? `${EXECUTION_COPY.stack.name} · ${stackWords(execution)}` : EXECUTION_COPY.hold.name}</b>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="cf-help">
              {draftProblem !== null
                ? 'Your design has to be changed first.'
                : draft !== null
                  ? <>{[...kinds].map((kind) => EXECUTION_COPY[kind].line).join(' ')} It comes from your design; change it there.</>
                  : <>{EXECUTION_COPY.hold.line} To stack an asset, set its schedule in the <Link to="/create">full designer</Link>.</>}
            </p>
            {idleLock && (
              <p className="cf-help" data-locked={idleLock.state}>
                <b>{idleLock.name}</b> <FeatureBadge lock={idleLock} /> Off. {idleLock.note}
              </p>
            )}
            {CHAIN.testnet && <p className="cf-help">Testnet: the USDT, the assets and their prices are simulated.</p>}
            {draftProblem === null && (
              <label className="cf-confirm">
                <input type="checkbox" checked={kindAgreed} onChange={(event) => setKindAgreed(event.target.checked)} />
                {executionConfirm(kinds)}
              </label>
            )}
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
              <dt>Buys</dt>
              <dd>{draftProblem !== null || kinds.size === 0 ? '—' : [...kinds].map((kind) => EXECUTION_COPY[kind].name).join(' and ')}</dd>
              <dt>Minimum deposit</dt>
              <dd>{selected.length === 0 ? '—' : `${minimumDeposit(selected.map(([address, percent]) => ({ address, weightBps: Math.round(percent * 100) })), usdt)} USDT`}</dd>
              <dt>Earn on idle USDT</dt>
              <dd>Off</dd>
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
