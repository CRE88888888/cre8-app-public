import { useEffect, useRef, useState } from 'react';
import type { ContributionPreviewBody } from './api';
import { previewScheduler, type PreviewState } from './contribution-preview';

/**
 * 入金期數預覽的 hook：本文變了才重排（比對 JSON），400ms debounce、只留最後一個請求（`previewScheduler`）。
 * `body === null`：不預覽（不是 chain 97、沒有 stack、金額是 0），回 idle。
 */
export function useContributionPreview(body: ContributionPreviewBody | null): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const scheduler = useRef<ReturnType<typeof previewScheduler> | null>(null);
  const key = body === null ? null : JSON.stringify(body);
  useEffect(() => {
    scheduler.current = previewScheduler(setState);
    return () => scheduler.current?.cancel();
  }, []);
  useEffect(() => {
    scheduler.current?.request(key === null ? null : (JSON.parse(key) as ContributionPreviewBody));
  }, [key]);
  return state;
}
