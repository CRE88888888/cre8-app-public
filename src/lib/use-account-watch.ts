import { useEffect } from 'react';
import { useSession } from '../store/session';
import { useWallet } from '../store/wallet';

/**
 * 監聽 MetaMask 的帳戶切換，讓 app 的登入狀態永遠跟著錢包**當前**帳戶走。
 *
 * ## 為什麼這是個必須修的 bug
 *
 * `use-auto-connect` 只在頁面載入時讀一次 `eth_accounts`。使用者之後在 MetaMask 切帳號，
 * app 完全不知道 —— 於是：
 *
 *   1. 使用者用帳戶 A 連上 app
 *   2. 在 MetaMask 切到帳戶 B
 *   3. 按 Sign in → app 還是用**舊的 A** 簽 SIWE（因為 store 沒更新）
 *   4. 投組 owner 記成 A，但使用者以為自己是 B
 *   5. B 簽的任何 UserOp 都被 Kernel 拒絕（AA24），A 則「明明沒錢卻 nonce 一直漲」
 *
 * 實測主網就踩到這個：一個投組的 owner 是 0x510c（使用者從沒轉錢進去的帳戶），
 * 使用者真正用的是 0xbB78。後果是看不到自己的部位、所有 sudo 操作 AA24。
 *
 * EIP-1193 的標準做法是監聽 `accountsChanged`：錢包一換帳戶就立刻通知 dapp。
 * MetaMask 會「把當前帳戶從清單裡移除再發事件」，所以事件可能給空清單 ——
 * 那代表帳戶被鎖定/登出，一樣要清掉登入狀態，不能留著舊帳戶繼續用。
 */
export function useAccountWatch(): void {
  useEffect(() => {
    // 訂閱時先拿一次「現在」的帳戶：有些錢包不保證在訂閱當下重播事件。
    const wallet = useWallet.getState();

    if (wallet.kind !== 'injected' || wallet.provider === null) return;

    const provider = wallet.provider;
    const refresh = async (): Promise<void> => {
      try {
        const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
        const current = accounts[0];
        const state = useWallet.getState();

        if (current === undefined) {
          // 錢包被鎖定或登出：清掉登入，不能留著舊帳戶繼續「假裝在線」。
          if (state.address !== null) state.disconnect();
          return;
        }
        if (current.toLowerCase() !== (state.address ?? '').toLowerCase()) {
          // 帳戶換了 → 換成新帳戶。signer/provider 不變，只是 address 變。
          state.connectInjected({ address: current, rdns: state.rdns ?? '', provider: state.provider! });
          // session token 綁的是「簽名那一刻的錢包」。錢包換了，token 就對不上 ——
          // 拿錯的 token 去打 API，後端 authenticate 會解出舊錢包，導致「看不到自己的投組」
          // （實測：要重新 sign-in 才看得到）。所以這裡主動清掉，讓 UI 提示重新登入。
          const session = useSession.getState();
          if (session.address !== null && session.address.toLowerCase() !== current.toLowerCase()) {
            session.clear();
          }
        }
      } catch {
        // 讀不到就算了：accountsChanged 事件本身是主要來源，這個只是補救。
      }
    };

    const onAccountsChanged = (accounts: unknown): void => {
      const list = Array.isArray(accounts) ? accounts : [];
      const first = typeof list[0] === 'string' ? (list[0] as string) : undefined;
      const state = useWallet.getState();
      if (first === undefined) {
        if (state.address !== null) state.disconnect();
        return;
      }
      if (first.toLowerCase() !== (state.address ?? '').toLowerCase()) {
        state.connectInjected({ address: first, rdns: state.rdns ?? '', provider: state.provider! });
        const session = useSession.getState();
        if (session.address !== null && session.address.toLowerCase() !== first.toLowerCase()) {
          session.clear();
        }
      }
    };

    provider.on?.('accountsChanged', onAccountsChanged);
    void refresh();

    return () => {
      provider.removeListener?.('accountsChanged', onAccountsChanged);
    };
  }, []);
}
