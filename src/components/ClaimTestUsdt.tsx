import { useState } from 'react';
import type { ReactNode } from 'react';
import { postFaucetUsdt } from '../lib/api';
import { faucetFailure, faucetSuccess } from '../lib/faucet';
import type { FaucetOutcome } from '../lib/faucet';
import { useConnectedSessionToken } from '../lib/use-connected-session';
import { useSession } from '../store/session';
import { useWallet } from '../store/wallet';

/**
 * 「Claim test USDT」：測試網的入金方式（cre8-app#62）。只在 `VITE_CHAIN_ID=97` 由 `FundingMethods` 顯示。
 *
 * 打後端的 `POST /faucet/usdt`，測試 USDT 會送到使用者的錢包（session 的錢包主人）。
 * 四種結果各有一句話：領到了、今天領過了、全站今天發完了、暫時不能領。
 */
export function ClaimTestUsdt(): ReactNode {
  const token = useConnectedSessionToken();
  const walletAddress = useWallet((state) => state.address);
  const sessionAddress = useSession((state) => state.address);
  const account = walletAddress ?? sessionAddress;
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<FaucetOutcome | null>(null);
  const signedIn = token !== null && account !== null;

  async function claim(): Promise<void> {
    if (token === null || account === null || busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(faucetSuccess(await postFaucetUsdt(token, account)));
    } catch (cause) {
      setOutcome(faucetFailure(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="feature-locked" data-state="on" data-entry="faucet">
      <div className="feature-locked__row">
        <span className="feature-locked__text">
          <span className="feature-locked__title"><b>Test USDT</b><span className="badge badge--ok feature-badge">Free</span></span>
          <small>{signedIn ? 'Sent to your wallet. For testing only; it has no value.' : 'Sign in to claim. For testing only; it has no value.'}</small>
        </span>
        <button type="button" className="btn sm" disabled={!signedIn || busy || outcome?.kind === 'claimed'} onClick={() => void claim()}>
          {busy ? 'Claiming…' : outcome?.kind === 'claimed' ? 'Claimed' : 'Claim'}
        </button>
      </div>
      {outcome !== null && (
        <p className="feature-locked__note" role="status" data-faucet={outcome.kind}>{outcome.message}</p>
      )}
    </div>
  );
}
