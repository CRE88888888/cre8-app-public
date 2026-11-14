import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * 認證狀態（client state）。放 sessionStorage，不放 localStorage：
 *
 * 這支 app 會動錢，token 的曝險窗口應該跟「這個分頁開著」一樣長。重新整理不用重簽（體驗），
 * 關掉分頁就清掉（安全）。localStorage 會讓 token 活到下次開瀏覽器 —— 對一個能動錢的 app，
 * 那個預設是錯的。
 */
/**
 * session 是怎麼來的（cre8-app#57）：
 * - `siwe`  ：連著的錢包簽 SIWE 換來的。session 與那個錢包綁在一起，錢包換了就失效。
 * - `privy` ：Privy 登入（email／Google／Apple／錢包）換來的。`address` 是後端記下的錢包主人，
 *             不一定是現在連著的錢包 —— 主人錢包沒連著時只能看，見 `use-connected-session.ts`。
 * 舊的持久化資料沒有這個欄位，當成 `siwe`。
 */
export type SessionVia = 'siwe' | 'privy';

export type SessionState = {
  token: string | null;
  expiresAt: string | null;
  address: string | null;
  via: SessionVia | null;
  setSession: (input: { token: string; expiresAt: string; address: string; via?: SessionVia }) => void;
  clear: () => void;
};

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      expiresAt: null,
      address: null,
      via: null,
      setSession: ({ token, expiresAt, address, via }) => set({ token, expiresAt, address, via: via ?? 'siwe' }),
      clear: () => set({ token: null, expiresAt: null, address: null, via: null }),
    }),
    {
      name: 'cre8.session',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ token: state.token, expiresAt: state.expiresAt, address: state.address, via: state.via }),
    },
  ),
);

/** token 是否還在有效期內（本地粗判，真正的權威是後端）。 */
export function sessionIsLive(state: { token: string | null; expiresAt: string | null }): boolean {
  if (state.token === null || state.expiresAt === null) return false;
  const expiry = new Date(state.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry > Date.now();
}
