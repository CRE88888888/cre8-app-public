import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, createStrategy, enrollPortfolio, getAssets, publishVersion } from '../../lib/api';
import type { PriceableAsset } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import { useSession } from '../../store/session';
import { ErrorNote, Note, Spinner } from '../../components/ui';

/** Rebalance cadence. The backend requires `intervalSeconds >= 60`; one hour is the shortest sensible cadence. */
const INTERVALS = [
  { label: 'Hourly', seconds: 3600 },
  { label: 'Every 6h', seconds: 21_600 },
  { label: 'Daily', seconds: 86_400 },
] as const;

type Step = 'idle' | 'creating-strategy' | 'publishing-version' | 'enrolling' | 'done';

const STEP_LABEL: Record<Exclude<Step, 'idle' | 'done'>, string> = {
  'creating-strategy': 'Creating the strategy (mirrors to the on-chain registry)…',
  'publishing-version': 'Publishing the version (weights + schedule)…',
  enrolling: 'Deploying the smart account (enroll)…',
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
export function CreateFundPage(): ReactNode {
  // The design's create page carries its own body class (`.create-page { background: var(--panel) }`).
  useBodyClass('create-page');
  const token = useSession((state) => state.token);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [intervalSeconds, setIntervalSeconds] = useState<number>(3600);
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ strategyId: number; portfolioId: number } | null>(null);

  const assets = useQuery({
    queryKey: ['assets', token],
    queryFn: () => getAssets(token as string),
    enabled: token !== null,
    staleTime: 60_000,
  });

  const selected = useMemo(() => Object.entries(weights).filter(([, percent]) => percent > 0), [weights]);
  /** Accumulate in bps, not floating percentages: `33.3 + 33.3 + 33.4` is not 100 in binary floating point. */
  const totalBps = selected.reduce((sum, [, percent]) => sum + Math.round(percent * 100), 0);
  const valid = name.trim().length > 0 && totalBps === 10_000;
  const busy = step !== 'idle' && step !== 'done';

  const toggle = (asset: PriceableAsset): void => {
    setWeights((current) => {
      const next = { ...current };
      if (next[asset.address] === undefined) next[asset.address] = 0;
      else delete next[asset.address];
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (token === null || !valid) return;
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

      setCreated({ strategyId: strategy.id, portfolioId: portfolio.id });
      setStep('done');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) }),
        queryClient.invalidateQueries({ queryKey: ['assets', token] }),
      ]);
    } catch (cause) {
      setError(cause);
      setStep('idle');
    }
  };

  if (token === null) {
    return (
      <main className="page stack">
        <h1>Create a fund</h1>
        <Note tone="warn">
          Creating a fund writes a strategy under your wallet and deploys a smart account.{' '}
          <Link to="/login">Sign in</Link> first.
        </Note>
      </main>
    );
  }

  return (
    <main className="page stack">
      <div>
        <p className="eyebrow">Create</p>
        <h1>Create a fund</h1>
        <p className="lead">
          One strategy: a <strong>target-weight index fund</strong>. You pick the holdings and weights; the scheduler
          swaps what is overweight into what is underweight (every leg is <em>asset ↔ USDT</em>).
        </p>
      </div>

      <section className="card stack">
        <h2>1 · Name</h2>
        <label className="field">
          <span>Fund name</span>
          <input
            id="fund-name"
            value={name}
            maxLength={120}
            placeholder="e.g. BNB Ecosystem Balanced"
            onChange={(event) => setName(event.target.value)}
          />
          <small>Shown on the vaults list.</small>
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <input
            id="fund-desc"
            value={description}
            maxLength={500}
            placeholder="The thesis, in one line"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </section>

      <section className="card stack">
        <div className="spread">
          <h2>2 · Holdings and weights</h2>
          <span className={totalBps === 10_000 ? 'pos mono' : 'neg mono'} style={{ fontSize: 13 }}>
            Total {(totalBps / 100).toFixed(2)}%
          </span>
        </div>

        {assets.isPending ? (
          <div className="row">
            <Spinner /> <span className="muted">Loading priceable assets…</span>
          </div>
        ) : assets.error !== null && assets.error !== undefined ? (
          <ErrorNote error={assets.error} />
        ) : assets.data === undefined ? null : assets.data.length === 0 ? (
          <Note tone="warn">`priceable_assets` is empty — someone has to add tokens before a fund can be created.</Note>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Pick</th>
                <th>Ticker</th>
                <th>Address</th>
                <th className="num">Weight %</th>
              </tr>
            </thead>
            <tbody>
              {assets.data.map((asset) => {
                const isOn = weights[asset.address] !== undefined;
                return (
                  <tr key={asset.address}>
                    <td>
                      <input
                        type="checkbox"
                        checked={isOn}
                        aria-label={`Select ${asset.symbol}`}
                        onChange={() => toggle(asset)}
                      />
                    </td>
                    <td>
                      <span className="mono">{asset.symbol}</span>
                      {asset.isNumeraire ? (
                        <span className="muted" style={{ fontSize: 11 }}>
                          {' '}
                          numeraire
                        </span>
                      ) : null}
                    </td>
                    <td className="mono muted" style={{ fontSize: 12 }}>
                      {asset.address.slice(0, 10)}…{asset.address.slice(-6)}
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        disabled={!isOn}
                        value={weights[asset.address] ?? 0}
                        style={{ width: 96, textAlign: 'right' }}
                        onChange={(event) => {
                          const percent = Number(event.target.value);
                          setWeights((current) => ({
                            ...current,
                            [asset.address]: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
                          }));
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {totalBps !== 10_000 && selected.length > 0 ? (
          <Note tone="warn">
            Weights must add up to exactly 100% (the backend requires 10000 bps). Currently {totalBps} bps.
          </Note>
        ) : null}
      </section>

      <section className="card stack">
        <h2>3 · Rebalance cadence</h2>
        <div className="row">
          {INTERVALS.map((option) => (
            <button
              key={option.seconds}
              type="button"
              className={`btn btn--sm${intervalSeconds === option.seconds ? '' : ' btn--ghost'}`}
              onClick={() => setIntervalSeconds(option.seconds)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          The scheduler checks drift on this cadence; it only trades past the threshold, and every step is bounded by
          the impact budget.
        </p>
      </section>

      <section className="card stack">
        <h2>4 · Create</h2>
        <dl className="kv">
          <dt>Strategy name</dt>
          <dd>{name.trim() === '' ? '(empty)' : name.trim()}</dd>
          <dt>Holdings</dt>
          <dd>
            {selected.length === 0
              ? '(none selected)'
              : selected
                  .map(([address]) => assets.data?.find((asset) => asset.address === address)?.symbol ?? address)
                  .join(' · ')}
          </dd>
          <dt>Cadence</dt>
          <dd>{INTERVALS.find((option) => option.seconds === intervalSeconds)?.label ?? `${intervalSeconds}s`}</dd>
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

        <div className="row">
          <button type="button" className="btn btn--primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create fund'}
          </button>
          {valid ? null : <span className="muted" style={{ fontSize: 12 }}>Needs a name and exactly 100% in weights</span>}
        </div>

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
            <div className="row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => navigate(`/portfolios/${created.portfolioId}`)}
              >
                Open the portfolio
              </button>
              <Link className="btn btn--sm btn--ghost" to="/vaults">
                Back to vaults
              </Link>
            </div>
          </Note>
        )}
      </section>
    </main>
  );
}
