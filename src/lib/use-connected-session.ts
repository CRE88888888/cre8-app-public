import { sessionIsLive, useSession } from '../store/session';
import type { SessionVia } from '../store/session';
import { useWallet } from '../store/wallet';

/**
 * 這個 session 現在能不能用（純函式，方便測）。
 *
 * - SIWE 的 session 與簽名的那個錢包綁在一起：錢包沒連著、或換成別的帳號，就不能用。
 * - Privy 的 session 對應後端記下的錢包主人，與「現在連著哪個錢包」無關：
 *   - 主人錢包連著 → 可以用，也可以簽名。
 *   - **沒有連任何錢包 → 仍然可以用，但只能看**（錢包註冊者改用 Google 等登入就是這個狀態；
 *     需要主人簽名的按鈕因為沒有錢包而停用，畫面會提示連回原本的錢包）。
 *   - 連著的是別的錢包 → 不能用。Privy 模式下 `PrivyRoot` 不會讓這個狀態停留（它只把主人錢包
 *     放進 store），這裡擋住是為了不讓任何頁面拿別人的錢包去簽主人的帳戶。
 */
export function usableSessionToken(input: {
  token: string | null;
  expiresAt: string | null;
  address: string | null;
  via: SessionVia | null;
  walletAddress: string | null;
}): string | null {
  if (!sessionIsLive(input) || input.address === null) return null;
  if (input.walletAddress === null) return input.via === 'privy' ? input.token : null;
  return input.address.toLowerCase() === input.walletAddress.toLowerCase() ? input.token : null;
}

export function useConnectedSessionToken(): string | null {
  const walletAddress = useWallet((state) => state.address);
  const { token, expiresAt, address, via } = useSession();
  return usableSessionToken({ token, expiresAt, address, via, walletAddress });
}

/**
 * 「這個使用者是誰」的地址：連著的錢包；沒有連錢包但用 Privy 登入時，是 session 的錢包主人。
 *
 * 給只需要**認人**的地方用（哪些基金是我建的、標頭顯示的地址）。要**簽名**的地方仍然用
 * `useOwnerWallet()`：只能看的狀態下它是 `null`，按鈕會停用。
 */
export function accountAddress(input: {
  token: string | null;
  expiresAt: string | null;
  address: string | null;
  via: SessionVia | null;
  walletAddress: string | null;
}): string | null {
  if (input.walletAddress !== null) return input.walletAddress;
  return input.via === 'privy' && sessionIsLive(input) ? input.address : null;
}

export function useAccountAddress(): string | null {
  const walletAddress = useWallet((state) => state.address);
  const { token, expiresAt, address, via } = useSession();
  return accountAddress({ token, expiresAt, address, via, walletAddress });
}
