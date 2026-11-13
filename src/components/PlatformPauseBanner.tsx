import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { getPortfolioStatus, getPortfolios } from '../lib/api';
import { PLATFORM_PAUSED_MESSAGE } from '../lib/a10';
import { readGlobalPaused } from '../lib/atp-contracts';
import { publicClientFor } from '../lib/kernel';
import { queryKeys } from '../lib/query';
import { useConnectedSessionToken } from '../lib/use-connected-session';
import { useOwnerWallet } from '../lib/use-owner-wallet';

/**
 * 全站橫幅：平台全域暫停交易時顯示（cre8-app#29 第 5 點）。
 *
 * 判斷來源是鏈上的 `executor.globalPaused()`，不是後端的說法 —— 那是 Safe 才能開關的總開關，
 * 開著的時候買、賣、再平衡全部被合約擋下，但使用者的資產仍在他自己的帳戶裡，可以用錢包直接領。
 *
 * ⚠ 目前只有「已登入而且至少有一個基金帳戶」的人看得到：前端要知道 executor 的位址才能問鏈，
 * 而那個位址現在只出現在 `GET /portfolios/:id/status`。沒有帳戶的人不受暫停影響（沒有資產在裡面），
 * 他們第一次買入時會在買入流程看到同一句話。要對所有訪客顯示，需要後端公開 executor 位址。
 *
 * 讀不到（舊合約沒有這個函式、RPC 掛了）就不顯示：橫幅只在確定暫停時出現。
 */
export function PlatformPauseBanner(): ReactNode {
  const wallet = useOwnerWallet();
  const token = useConnectedSessionToken();
  const portfolios = useQuery({
    queryKey: queryKeys.portfolios(token),
    queryFn: () => getPortfolios(token as string),
    enabled: token !== null,
    staleTime: 60_000,
  });
  const first = portfolios.data?.[0];
  // 與基金頁同一個 queryKey，兩邊共用同一份快取。
  const status = useQuery({
    queryKey: ['fund-status', token, first?.id],
    queryFn: () => getPortfolioStatus(token as string, first?.id as number),
    enabled: token !== null && first !== undefined,
    staleTime: 60_000,
    retry: 0,
  });
  const executor = status.data?.executorAddress ?? null;
  const paused = useQuery({
    queryKey: ['a10-global-paused', executor?.toLowerCase() ?? null],
    queryFn: () => readGlobalPaused(publicClientFor(wallet as NonNullable<typeof wallet>), executor as Address),
    enabled: wallet !== null && executor !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (paused.data !== true) return null;
  return (
    <div className="platform-banner" role="status">
      <strong>Trading is paused.</strong> {PLATFORM_PAUSED_MESSAGE.replace('Trading is paused across the platform. ', '')}
    </div>
  );
}
