import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, createStrategy, enrollPortfolio, getAssets, publishVersion } from '../../lib/api';
import type { PriceableAsset } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useSession } from '../../store/session';
import { ErrorNote, Note, Spinner } from '../../components/ui';

/** 再平衡節奏的選項。後端要求 `intervalSeconds >= MIN_INTERVAL_SECONDS`（60），一小時是最短的合理值。 */
const INTERVALS = [
  { label: '每小時', seconds: 3600 },
  { label: '每 6 小時', seconds: 21_600 },
  { label: '每天', seconds: 86_400 },
] as const;

type Step = 'idle' | 'creating-strategy' | 'publishing-version' | 'enrolling' | 'done';

const STEP_LABEL: Record<Exclude<Step, 'idle' | 'done'>, string> = {
  'creating-strategy': '建立策略（含鏈上 Registry 鏡像）…',
  'publishing-version': '發佈版本（資產權重 + 排程）…',
  enrolling: '部署 smart account（enroll）…',
};

/**
 * Create fund —— **只有一種策略：目標權重指數基金**。
 *
 * 設計稿的 builder 有 Buy & hold、Stack、Pair grid 等範本；那些在我們的後端沒有對應的執行路徑，
 * 所以這裡不假裝有。畫面只做一件事：把「資產 + 權重 + 再平衡節奏」變成
 * `strategy` → `version` → `portfolio` 三個真的資源。
 *
 * 三步是**真的三次後端呼叫**（第 1、3 步會上鏈），所以進度要逐步顯示 ——
 * 一個轉圈 30 秒、什麼都不說的按鈕會讓人以為壞掉而重複按。
 */
export function CreateFundPage(): ReactNode {
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

  const selected = useMemo(
    () => Object.entries(weights).filter(([, percent]) => percent > 0),
    [weights],
  );
  /** 用 bps 累加而不是浮點百分比：`33.3 + 33.3 + 33.4` 在浮點裡不是 100。 */
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
          建立基金會在你的錢包名下寫入策略並部署 smart account，需要先<Link to="/login">登入</Link>。
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
          一種策略：<strong>目標權重指數基金</strong>。你決定持倉與權重，排程器在偏離門檻時把超配的換成低配的
          （每條腿都是「資產 ↔ USDT」）。
        </p>
      </div>

      <section className="card stack">
        <h2>1 · 名稱</h2>
        <div className="field">
          <label htmlFor="fund-name">基金名稱</label>
          <input
            id="fund-name"
            value={name}
            maxLength={120}
            placeholder="例如：BNB 生態平衡"
            onChange={(event) => setName(event.target.value)}
          />
          <span className="field__hint">顯示在 vaults 列表上。</span>
        </div>
        <div className="field">
          <label htmlFor="fund-desc">說明（選填）</label>
          <input
            id="fund-desc"
            value={description}
            maxLength={500}
            placeholder="這個基金的主張，一句話"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </section>

      <section className="card stack">
        <div className="spread">
          <h2>2 · 持倉與權重</h2>
          <span className={totalBps === 10_000 ? 'pos mono' : 'neg mono'} style={{ fontSize: 13 }}>
            合計 {(totalBps / 100).toFixed(2)}%
          </span>
        </div>

        {assets.isPending ? (
          <div className="row">
            <Spinner /> <span className="muted">讀取可定價資產…</span>
          </div>
        ) : assets.error !== null && assets.error !== undefined ? (
          <ErrorNote error={assets.error} />
        ) : assets.data === undefined ? null : assets.data.length === 0 ? (
          <Note tone="warn">`priceable_assets` 是空的 —— 先有人把代幣加進去才能建立基金。</Note>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>選</th>
                <th>代號</th>
                <th>地址</th>
                <th className="num">權重 %</th>
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
                        aria-label={`選 ${asset.symbol}`}
                        onChange={() => toggle(asset)}
                      />
                    </td>
                    <td>
                      <span className="mono">{asset.symbol}</span>
                      {asset.isNumeraire ? (
                        <span className="muted" style={{ fontSize: 11 }}>
                          {' '}
                          計價基準
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
            權重必須剛好 100%（後端要求權重加總 10000 bps）。目前 {totalBps} bps。
          </Note>
        ) : null}
      </section>

      <section className="card stack">
        <h2>3 · 再平衡節奏</h2>
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
          排程器以這個間隔檢查漂移；超過門檻才動作，且每個 step 受 impact 預算限制。
        </p>
      </section>

      <section className="card stack">
        <h2>4 · 建立</h2>
        <dl className="kv">
          <dt>策略名稱</dt>
          <dd>{name.trim() === '' ? '（未填）' : name.trim()}</dd>
          <dt>持倉</dt>
          <dd>{selected.length === 0 ? '（未選）' : selected.map(([address]) => assets.data?.find((a) => a.address === address)?.symbol ?? address).join(' · ')}</dd>
          <dt>節奏</dt>
          <dd>{INTERVALS.find((option) => option.seconds === intervalSeconds)?.label ?? `${intervalSeconds}s`}</dd>
        </dl>

        {step !== 'idle' && step !== 'done' ? (
          <Note>
            <div className="row">
              <Spinner /> <strong>{STEP_LABEL[step]}</strong>
            </div>
            <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
              第 1 步會把策略鏡像到鏈上 Registry、第 3 步會部署 smart account —— 這兩步要花 gas 與時間，
              不是卡住。
            </p>
          </Note>
        ) : null}

        <div className="row">
          <button type="button" className="btn btn--primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? '建立中…' : '建立基金'}
          </button>
          {valid ? null : <span className="muted" style={{ fontSize: 12 }}>名稱與 100% 權重都填好才能建立</span>}
        </div>

        <ErrorNote error={error} />
        {error instanceof ApiError && error.code === 'CHAIN_NOT_CONFIGURED' ? (
          <Note tone="warn">
            後端沒有設定鏈（`RPC_URL` / `OPERATOR_PRIVATE_KEY`）。建立策略要鏡像到鏈上 Registry，缺設定時會擋在這裡。
          </Note>
        ) : null}

        {created === null ? null : (
          <Note>
            <strong>建立完成</strong>
            <div style={{ marginTop: 6 }}>
              策略 #{created.strategyId} · 投組 #{created.portfolioId}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => navigate(`/portfolios/${created.portfolioId}`)}
              >
                看這個投組
              </button>
              <Link className="btn btn--sm btn--ghost" to="/vaults">
                回 vaults
              </Link>
            </div>
          </Note>
        )}
      </section>
    </main>
  );
}
