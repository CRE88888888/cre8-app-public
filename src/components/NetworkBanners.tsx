import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { isWrongNetwork, walletChainParams } from '../lib/chain-config';
import { CHAIN, CHAIN_ID } from '../lib/kernel';
import { chainIdOf, ensureChain } from '../lib/wallet';
import { useWallet } from '../store/wallet';

/**
 * 全站橫幅：這是測試網，測試幣沒有價值（cre8-app#62）。只在 `VITE_CHAIN_ID=97` 出現，不能關掉 ——
 * 測試網上每一頁都要看得到這句話，免得有人把測試幣當成真的錢。
 */
export function TestnetBanner(): ReactNode {
  if (!CHAIN.testnet) return null;
  return (
    <div className="platform-banner" role="note" data-banner="testnet">
      <strong>Testnet.</strong> You are on {CHAIN.name}. Tokens here are for testing only and have no value.
    </div>
  );
}

/**
 * 全站橫幅：錢包不在這個 app 的鏈上（測試網，cre8-app#62）。
 *
 * 錢包在別條鏈時，簽名請求會被錢包擋掉或送到別的網路，畫面看起來像「沒反應」。這裡明講，並給一顆切換的連結：
 * 錢包不認識測試網時會先把它加進去（`ensureChain`）。只處理外部錢包；Privy 的嵌入式錢包由 Privy 自己切。
 * 主網與本機 fork 不顯示（行為照舊，由錢包選單裡的診斷處理）。
 */
export function WrongNetworkNotice(): ReactNode {
  const provider = useWallet((state) => state.provider);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    setWalletChainId(null);
    setProblem(null);
    if (!CHAIN.testnet || provider === null) return;
    let cancelled = false;
    void chainIdOf(provider).then((id) => { if (!cancelled) setWalletChainId(id); }).catch(() => undefined);
    const onChainChanged = (value: unknown): void => {
      const id = typeof value === 'string' ? Number.parseInt(value, 16) : typeof value === 'number' ? value : NaN;
      if (Number.isFinite(id)) setWalletChainId(id);
    };
    provider.on?.('chainChanged', onChainChanged);
    return () => {
      cancelled = true;
      provider.removeListener?.('chainChanged', onChainChanged);
    };
  }, [provider]);

  if (!CHAIN.testnet || provider === null || !isWrongNetwork(CHAIN, walletChainId)) return null;

  async function switchNetwork(): Promise<void> {
    if (provider === null) return;
    setSwitching(true);
    setProblem(null);
    try {
      const result = await ensureChain(provider, CHAIN_ID, walletChainParams(CHAIN));
      if (result === 'declined') setProblem('The switch was cancelled in your wallet.');
      else setWalletChainId(await chainIdOf(provider).catch(() => CHAIN_ID));
    } catch {
      setProblem(`Your wallet could not switch. Open it and choose ${CHAIN.name} (chain ${CHAIN.id}).`);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="platform-banner" role="alert" data-banner="wrong-network">
      <strong>Wrong network.</strong> Your wallet is on chain {walletChainId}, but CRE8 runs on {CHAIN.name}. Nothing can be signed until you switch.{' '}
      <button type="button" className="link-button" disabled={switching} onClick={() => void switchNetwork()}>
        {switching ? 'Switching…' : `Switch to ${CHAIN.name}`}
      </button>
      {problem !== null && <> {problem}</>}
    </div>
  );
}
