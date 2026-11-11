import { useEffect } from 'react';
import { useSession } from '../store/session';
import { useWallet } from '../store/wallet';

/** 連線後即開始監聽。切換或鎖定帳戶時，舊 session 不再用於目前的錢包。 */
export function useAccountWatch(): void {
  const provider = useWallet((state) => state.provider);

  useEffect(() => {
    if (provider === null) return;
    let disposed = false;
    let receivedEvent = false;

    const applyAccounts = (accounts: unknown): void => {
      const wallet = useWallet.getState();
      if (disposed || wallet.provider !== provider) return;
      const first = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null;
      const session = useSession.getState();

      if (first === null) {
        session.clear();
        wallet.disconnect();
        return;
      }
      if (session.address !== null && session.address.toLowerCase() !== first.toLowerCase()) {
        session.clear();
      }
      if (first.toLowerCase() !== wallet.address?.toLowerCase()) {
        wallet.connectInjected({ address: first, rdns: wallet.rdns ?? '', provider });
      }
    };

    const onAccountsChanged = (accounts: unknown): void => {
      receivedEvent = true;
      applyAccounts(accounts);
    };
    provider.on?.('accountsChanged', onAccountsChanged);
    void provider.request({ method: 'eth_accounts' }).then((accounts) => {
      if (!receivedEvent) applyAccounts(accounts);
    }).catch(() => {
      // 錢包若拒絕補讀，仍以 accountsChanged 事件更新。
    });

    return () => {
      disposed = true;
      provider.removeListener?.('accountsChanged', onAccountsChanged);
    };
  }, [provider]);
}
