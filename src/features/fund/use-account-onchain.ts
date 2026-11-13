import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Address } from 'viem';
import { readBuyAllowance, readGlobalPaused, readOnchainAccount } from '../../lib/atp-contracts';
import type { BuyAllowance, OnchainAccount } from '../../lib/atp-contracts';
import { publicClientFor } from '../../lib/kernel';
import type { RenewalWallet } from '../../lib/kernel';

/**
 * 一個基金帳戶在鏈上的 A10 狀態（cre8-app#29）：enroll 的策略與版本、暫停來源、全域暫停、買入額度。
 *
 * 用使用者錢包自己的 RPC 讀（跟頁面上其他鏈上讀取一樣），所以沒連錢包時不查。
 * 每一項各自失敗各自是 `null` —— 尤其是 A10 之前的合約沒有 `globalPaused`／`buyAllowance`／
 * `pauseFlags`。`null` 的意思是「不知道」，畫面上就不顯示那一項，不可以當成 false 或 0。
 */
export type AccountOnchain = {
  account: OnchainAccount | null;
  globalPaused: boolean | null;
  allowance: BuyAllowance | null;
};

export function accountOnchainKey(executor: string | null | undefined, account: string | null | undefined): readonly unknown[] {
  return ['a10-account', executor?.toLowerCase() ?? null, account?.toLowerCase() ?? null];
}

export async function loadAccountOnchain(wallet: RenewalWallet, executor: Address, account: Address): Promise<AccountOnchain> {
  const client = publicClientFor(wallet);
  const [state, globalPaused, allowance] = await Promise.all([
    readOnchainAccount(client, executor, account).catch(() => null),
    readGlobalPaused(client, executor),
    readBuyAllowance(client, executor, account),
  ]);
  return { account: state, globalPaused, allowance };
}

export function useAccountOnchain(
  wallet: RenewalWallet | null,
  executor: string | null | undefined,
  account: string | null | undefined,
): UseQueryResult<AccountOnchain> {
  const enabled = wallet !== null && typeof executor === 'string' && typeof account === 'string';
  return useQuery({
    queryKey: accountOnchainKey(executor, account),
    queryFn: () => loadAccountOnchain(wallet as RenewalWallet, executor as Address, account as Address),
    enabled,
    staleTime: 15_000,
    // 全域暫停與額度窗口會自己變：每分鐘重讀一次，橫幅與提示才不會停在舊狀態。
    refetchInterval: 60_000,
  });
}
