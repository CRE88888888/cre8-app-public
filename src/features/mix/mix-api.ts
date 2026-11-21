/**
 * My mix 的 API（cre8-app#132，backend#179／#181／#183，文件 backend `docs/my-mix.zh-TW.md`）。
 *
 * - 免登入：`POST /mixes/preview`、`GET /mixes/shared/:code`。
 * - 要登入（SIWE Bearer）：`/me/mixes` 底下的列表、明細、建立、PATCH、confirm、restart、enrollment-params。
 * - 建立一定帶 `Idempotency-Key`：同一次建立重試沿用同一把，換設定才換新的（後端同 key 不同 body 回 409）。
 *
 * 假資料只留在測試（`tests/fixtures/mix-fixtures.ts`）。
 */
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiRequest } from '../../lib/api';
import { useConnectedSessionToken } from '../../lib/use-connected-session';
import type { CreateMixInput, MixAsset, MixDetail, MixPreview, MixSigningPayload, SharedMix } from './mix-types';

/** PATCH 只改名稱、頻率、Exit 時回明細；有改成分時回要簽的 calls。 */
export type MixPatchResult = MixDetail | MixSigningPayload;
export const needsSignature = (result: MixPatchResult): result is MixSigningPayload => 'intentId' in result;

const json = (method: 'POST' | 'PATCH', token: string | null, body: unknown, headers?: Record<string, string>) => ({
  method, token, body, ...(headers === undefined ? {} : { headers }),
});

export const mixApi = {
  preview: (assets: MixAsset[]) => apiRequest<MixPreview>('/mixes/preview', json('POST', null, { assets })),
  shared: (code: string) => apiRequest<SharedMix>(`/mixes/shared/${encodeURIComponent(code)}`),
  list: (token: string) => apiRequest<{ mixes: MixDetail[] }>('/me/mixes', { token }),
  get: (token: string, id: number) => apiRequest<MixDetail>(`/me/mixes/${id}`, { token }),
  create: (token: string, input: CreateMixInput, idempotencyKey: string) =>
    apiRequest<MixSigningPayload>('/me/mixes', json('POST', token, input, { 'Idempotency-Key': idempotencyKey })),
  patch: (token: string, id: number, patch: CreateMixInput) => apiRequest<MixPatchResult>(`/me/mixes/${id}`, json('PATCH', token, patch)),
  /** 重讀還沒簽的 calls（關掉分頁後回來完成）。 */
  prepare: (token: string, id: number) => apiRequest<MixSigningPayload>(`/me/mixes/${id}/enrollment-params`, json('POST', token, {})),
  confirm: (token: string, id: number, txHash: string) =>
    apiRequest<{ mixId: number; portfolioId: number; account: string; message: string }>(`/me/mixes/${id}/confirm`, json('POST', token, { txHash })),
  restart: (token: string, id: number) => apiRequest<{ mixId: number; status: string; message: string }>(`/me/mixes/${id}/restart`, json('POST', token, {})),
};

/** 4xx（查無、沒登入、格式不對）重試也一樣，不重試；網路或 5xx 再試一次。 */
export function retryMixQuery(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failures < 1;
}

/** 1–128 個英數字、`_`、`-`（後端規則）；用 UUID。 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function usePreview(assets: MixAsset[]) {
  const key = assets.map((a) => `${a.assetId}:${a.weightBps}`).join(',');
  return useQuery({
    queryKey: ['mix-preview', key],
    queryFn: () => mixApi.preview(assets),
    enabled: assets.length > 0,
    staleTime: 60_000,
    retry: retryMixQuery,
    placeholderData: (previous) => previous,
  });
}

export function useMixes() {
  const token = useConnectedSessionToken();
  return useQuery({ queryKey: ['mixes', token], queryFn: () => mixApi.list(token!), enabled: token !== null, retry: retryMixQuery });
}

export function useMix(id: number) {
  const token = useConnectedSessionToken();
  return useQuery({
    queryKey: ['mix', id, token],
    queryFn: () => mixApi.get(token!, id),
    retry: retryMixQuery,
    enabled: token !== null && Number.isSafeInteger(id) && id > 0,
  });
}
