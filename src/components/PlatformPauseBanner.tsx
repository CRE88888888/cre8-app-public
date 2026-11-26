import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getPlatformPaused } from '../lib/api';
import { PLATFORM_PAUSED_MESSAGE } from '../lib/a10';

/**
 * 全站橫幅：平台全域暫停交易時顯示（cre8-app#29 第 5 點；cre8-app#41 改讀公開端點）。
 *
 * 來源是後端的公開端點 `GET /platform/status`（它讀鏈上的 `executor.globalPaused()`，快取 10 秒），
 * 所以**不用登入、不用連錢包**，所有訪客都看得到。全域暫停是 Safe 才能開關的總開關：開著的時候
 * 買、賣、再平衡全部被合約擋下，但使用者的資產仍在他自己的帳戶裡，可以用錢包直接領。
 *
 * 三種答案，三種處理：
 * - `true`  → 顯示橫幅。
 * - `false` → 不顯示。
 * - 不知道（503、A 段臨時網址的 PREVIEW_ONLY、網路失敗）→ **不改變畫面**：
 *   沒看過確定的答案就不顯示；上一次確定是暫停的話，橫幅留著。
 *   不顯示「狀態無法確認」：臨時網址上那會是一條永遠掛著的訊息，後端短暫讀不到鏈時也只會嚇到人。
 *   不顯示不等於說「沒有暫停」—— 真的暫停時，買賣流程自己還會再告訴使用者一次。
 *
 * 做法：查詢函式在「不知道」時丟錯，react-query 會保留上一次成功的資料，正好就是上面的行為。
 */
export function PlatformPauseBanner(): ReactNode {
  const paused = useQuery({
    queryKey: ['platform-paused'],
    queryFn: async ({ signal }) => {
      const answer = await getPlatformPaused(signal);
      if (answer === null) throw new Error('platform status unknown');
      return answer;
    },
    retry: 0,
    staleTime: 30_000,
    // 知道答案時每分鐘重問；不知道時（例如臨時網址）放慢到五分鐘，不要一直打一個只會回 503 的端點。
    refetchInterval: (query) => (query.state.status === 'error' ? 300_000 : 60_000),
  });

  if (paused.data !== true) return null;
  return (
    <div className="platform-banner" role="status">
      <strong>Trading is paused.</strong> {PLATFORM_PAUSED_MESSAGE.replace('Trading is paused across the platform. ', '')}
    </div>
  );
}
