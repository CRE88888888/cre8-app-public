import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { cleanDisplayName } from '../lib/profile-name';

/**
 * 使用者自己取的顯示名稱，以錢包主人地址（小寫）為鍵。
 *
 * 放 localStorage：名字不是機密，而且關掉分頁後應該還在。只存在這台裝置 —— 後端有用戶資料之後改存後端。
 */
type ProfileNames = {
  names: Record<string, string>;
  /** 存一個名字；空字串＝清掉（回到已綁帳號的名字）。 */
  setName: (address: string, name: string) => void;
};

export const useProfileNames = create<ProfileNames>()(
  persist(
    (set) => ({
      names: {},
      setName: (address, name) =>
        set((state) => {
          const key = address.toLowerCase();
          const clean = cleanDisplayName(name);
          const names = { ...state.names };
          if (clean === '') delete names[key];
          else names[key] = clean;
          return { names };
        }),
    }),
    { name: 'cre8.profileNames', storage: createJSONStorage(() => localStorage) },
  ),
);

export function useCustomName(address: string | null): string | null {
  return useProfileNames((state) => (address === null ? null : state.names[address.toLowerCase()] ?? null));
}
