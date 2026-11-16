import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { readVersionSchedule, type VersionSchedule } from '../../lib/atp-contracts';
import { CHAIN, readOnlyClient } from '../../lib/kernel';

/**
 * 這檔策略在鏈上的版本排程（P11，cre8-contracts#54）：目前生效版、待生效版、上次發版時間、曾經生效的資產。
 * 只有地址簿上有 registry 的鏈（chain 97）才讀；chain 56 不讀（回 undefined）。不用登入：用唯讀 RPC。
 * 讀不到（舊合約沒有 `pendingVersion`、RPC 失敗）是 error，畫面就不顯示版本通知。
 */
export function useVersionSchedule(onchainId: number | null | undefined) {
  const registry = CHAIN.contracts?.registry ?? null;
  return useQuery<VersionSchedule>({
    queryKey: ['version-schedule', CHAIN.id, registry, onchainId ?? null],
    queryFn: () => readVersionSchedule(readOnlyClient(), registry as Address, BigInt(onchainId as number)),
    enabled: registry !== null && typeof onchainId === 'number' && onchainId > 0,
    staleTime: 30_000,
    // 生效時間到了畫面要跟著變：每分鐘重讀。
    refetchInterval: 60_000,
    retry: 1,
  });
}
