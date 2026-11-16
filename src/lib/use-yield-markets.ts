import { useQuery } from '@tanstack/react-query';
import { getYieldMarkets } from './api';
import { CHAIN } from './kernel';
import type { YieldMarketList } from './yield';

export const yieldMarketsKey = (chainId: number) => ['yield-markets', chainId] as const;

/**
 * 這條鏈的生息市場清單（公開端點，不用登入）。只有 chain 97 有；回應已核對地址簿（`getYieldMarkets`）。
 * `data === null`：這條鏈沒有生息；畫面維持「Coming soon」。`isError`：讀取失敗，要給重試、不能拿舊資料送簽。
 */
export function useYieldMarkets(): {
  data: YieldMarketList | null | undefined;
  isError: boolean;
  isPending: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: yieldMarketsKey(CHAIN.id),
    queryFn: ({ signal }) => getYieldMarkets(CHAIN.id, signal),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return { data: query.data, isError: query.isError, isPending: query.isPending, error: query.error, refetch: query.refetch };
}
