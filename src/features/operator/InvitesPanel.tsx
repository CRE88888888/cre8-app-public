import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, createOperatorInvites, getOperatorInviteSummary, getOperatorInvites, revokeOperatorInvite } from '../../lib/api';
import type { InviteBatch, InviteRow, InviteStatus } from '../../lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge, ErrorNote, Spinner } from '../../components/ui';
import { toast } from '../../components/Toast';

/**
 * 邀請碼後台（使用者 2026-11-16；backend#132 `docs/waitlist-api.zh-TW.md`）：
 * 產生一批碼發給某人、看每個人發了幾個用掉幾個、每個碼發給誰（issuedTo）與最後被誰用掉（usedBy）、作廢沒用的碼。
 * 系統只知道「發給誰」與「最後誰用掉」，中間轉手看不到。明碼只在產生的那一次出現，關掉就查不到了。
 */

const STATUS_TEXT: Record<InviteStatus, string> = { unused: 'Unused', used: 'Used', revoked: 'Revoked', expired: 'Expired' };
const STATUS_TONE: Record<InviteStatus, 'ok' | 'warn' | 'neutral' | 'bad'> = { unused: 'warn', used: 'ok', revoked: 'neutral', expired: 'neutral' };
const FILTERS: readonly (InviteStatus | 'all')[] = ['all', 'unused', 'used', 'revoked', 'expired'];

const forbiddenText = 'This account is not on the operator list, so it can’t manage invite codes.';
const isForbidden = (error: unknown): boolean => error instanceof ApiError && error.status === 403;

/** 產生表單的輸入檢查（與後端同規則）：數量 1–500；收件人與備註最多 256 字；到期日要在未來。回錯誤句子或 null。 */
export function inviteFormProblem(input: { count: string; issuedTo: string; batchNote: string; expiresOn: string }, now: number = Date.now()): string | null {
  const count = Number(input.count);
  if (!/^\d+$/.test(input.count.trim()) || !Number.isInteger(count) || count < 1 || count > 500) return 'Make between 1 and 500 codes at a time.';
  if (input.issuedTo.trim().length > 256 || input.batchNote.trim().length > 256) return 'Keep the recipient and the note under 256 characters.';
  if (input.expiresOn !== '' && !(Date.parse(`${input.expiresOn}T23:59:59.000Z`) > now)) return 'Pick an expiry date in the future.';
  return null;
}

/** 表單換成 API 本文：空白欄位送 null；到期日是那天 UTC 23:59:59。 */
export function inviteRequest(input: { count: string; issuedTo: string; batchNote: string; expiresOn: string }): { count: number; issuedTo: string | null; batchNote: string | null; expiresAt: string | null } {
  const blank = (value: string) => (value.trim() === '' ? null : value.trim());
  return { count: Number(input.count), issuedTo: blank(input.issuedTo), batchNote: blank(input.batchNote), expiresAt: input.expiresOn === '' ? null : `${input.expiresOn}T23:59:59.000Z` };
}

const when = (iso: string | null): string => (iso === null ? '—' : new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));

function NewBatch({ batch, onClose }: { batch: InviteBatch; onClose: () => void }): ReactNode {
  const text = batch.items.map((item) => item.code).join('\n');
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast.ok(`Copied ${batch.items.length} ${batch.items.length === 1 ? 'code' : 'codes'}`);
    } catch {
      toast.bad('Could not copy', 'Select the codes and copy them by hand.');
    }
  };
  return (
    <div className="card" role="status" style={{ marginTop: 12 }} data-entry="new-invites">
      <p style={{ margin: 0 }}>
        <strong>{batch.items.length} new {batch.items.length === 1 ? 'code' : 'codes'}</strong>
        {batch.issuedTo !== null && <> for {batch.issuedTo}</>}
        {batch.expiresAt !== null && <> · expires {when(batch.expiresAt)}</>}
      </p>
      <p className="fine warn" style={{ margin: '6px 0 8px' }}>Save or send these now. They are shown only once and can’t be looked up later.</p>
      <textarea readOnly value={text} rows={Math.min(10, batch.items.length)} aria-label="New invite codes" style={{ width: '100%', fontFamily: 'var(--mono)' }} onFocus={(event) => event.currentTarget.select()} />
      <div className="row" style={{ marginTop: 8 }}>
        <Button size="sm" onClick={() => void copy()}>Copy all</Button>
        <Button size="sm" variant="outline" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

export function InvitesPanel({ token }: { token: string }): ReactNode {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ count: '10', issuedTo: '', batchNote: '', expiresOn: '' });
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<InviteBatch | null>(null);
  const [filter, setFilter] = useState<InviteStatus | 'all'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const problem = inviteFormProblem(form);

  const summary = useQuery({
    queryKey: ['operator-invite-summary', token],
    queryFn: () => getOperatorInviteSummary(token),
    retry: false,
  });
  const list = useInfiniteQuery({
    queryKey: ['operator-invites', token, filter],
    queryFn: ({ pageParam }) => getOperatorInvites(token, { status: filter, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? null,
    retry: false,
  });
  const rows: InviteRow[] = list.data?.pages.flatMap((page) => page.items) ?? [];
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['operator-invites', token] }),
      queryClient.invalidateQueries({ queryKey: ['operator-invite-summary', token] }),
    ]);
  };

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (problem !== null || creating) return;
    setCreating(true);
    try {
      setFresh(await createOperatorInvites(token, inviteRequest(form)));
      await refresh();
    } catch (cause) {
      toast.bad('Could not make codes', isForbidden(cause) ? forbiddenText : (cause as Error).message.split('\n')[0]?.slice(0, 140) ?? '');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(row: InviteRow): Promise<void> {
    setBusy(row.id);
    try {
      await revokeOperatorInvite(token, row.id);
      toast.ok('Code revoked');
      await refresh();
    } catch (cause) {
      const used = cause instanceof ApiError && cause.code === 'INVITE_USED';
      toast.bad('Could not revoke', used ? 'This code was already used.' : isForbidden(cause) ? forbiddenText : (cause as Error).message.split('\n')[0]?.slice(0, 140) ?? '');
    } finally {
      setBusy(null);
    }
  }

  const set = (field: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [field]: event.target.value }));

  return (
    <div className="panel" style={{ marginTop: 20 }} id="invites">
      <div className="panel-h">
        <h2>Invite codes</h2>
      </div>
      <div className="panel-b">
        <form className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }} onSubmit={(event) => void create(event)}>
          <label className="field" style={{ width: 90 }}>
            <span>How many</span>
            <input type="number" min={1} max={500} inputMode="numeric" value={form.count} onChange={set('count')} />
          </label>
          <label className="field" style={{ flex: '1 1 180px' }}>
            <span>For (optional)</span>
            <input value={form.issuedTo} placeholder="@handle or a name" maxLength={256} onChange={set('issuedTo')} />
          </label>
          <label className="field" style={{ flex: '1 1 180px' }}>
            <span>Note (optional)</span>
            <input value={form.batchNote} placeholder="e.g. KOL round" maxLength={256} onChange={set('batchNote')} />
          </label>
          <label className="field" style={{ width: 170 }}>
            <span>Expires (optional, UTC)</span>
            <input type="date" value={form.expiresOn} onChange={set('expiresOn')} />
          </label>
          <Button type="submit" disabled={problem !== null || creating}>{creating ? 'Making…' : 'Make codes'}</Button>
        </form>
        {problem !== null && <p className="fine warn" role="status">{problem}</p>}
        {fresh !== null && <NewBatch batch={fresh} onClose={() => setFresh(null)} />}

        <h3 style={{ marginTop: 20 }}>By recipient</h3>
        {summary.isPending ? (
          <div className="row"><Spinner /> <span className="muted">Loading…</span></div>
        ) : isForbidden(summary.error) ? (
          <p className="muted" role="status">{forbiddenText}</p>
        ) : summary.error ? (
          <ErrorNote error={summary.error} />
        ) : (summary.data?.items ?? []).length === 0 ? (
          <p className="muted">No codes made yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow><TableHead>For</TableHead><TableHead>Issued</TableHead><TableHead>Used</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {(summary.data?.items ?? []).map((item) => (
                <TableRow key={item.issuedTo ?? '(none)'}>
                  <TableCell>{item.issuedTo ?? <span className="muted">No recipient</span>}</TableCell>
                  <TableCell>{item.issued}</TableCell>
                  <TableCell>{item.used}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <div className="row" style={{ marginTop: 20, justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Codes</h3>
          <div className="row" role="group" aria-label="Show codes">
            {FILTERS.map((value) => (
              <button key={value} type="button" className={`btn sm${filter === value ? '' : ' ghost'}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {value === 'all' ? 'All' : STATUS_TEXT[value]}
              </button>
            ))}
          </div>
        </div>
        {list.isPending ? (
          <div className="row"><Spinner /> <span className="muted">Loading codes…</span></div>
        ) : isForbidden(list.error) ? (
          <p className="muted" role="status">{forbiddenText}</p>
        ) : list.error ? (
          <ErrorNote error={list.error} />
        ) : rows.length === 0 ? (
          <p className="muted">No codes here.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead><TableHead>For</TableHead><TableHead>Note</TableHead><TableHead>Status</TableHead>
                  <TableHead>Used by</TableHead><TableHead>Made</TableHead><TableHead>Expires</TableHead><TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="mono">{row.codeMasked}</TableCell>
                    <TableCell>{row.issuedTo ?? '—'}</TableCell>
                    <TableCell>{row.batchNote ?? '—'}</TableCell>
                    <TableCell><Badge tone={STATUS_TONE[row.status]}>{STATUS_TEXT[row.status]}</Badge></TableCell>
                    <TableCell>
                      {row.xHandle !== null
                        ? <a href={`https://x.com/${row.xHandle}`} target="_blank" rel="noopener noreferrer">@{row.xHandle}</a>
                        : '—'}
                      {row.usedAt !== null && <div className="fine muted">{when(row.usedAt)}</div>}
                    </TableCell>
                    <TableCell>{when(row.createdAt)}</TableCell>
                    <TableCell>{when(row.expiresAt)}</TableCell>
                    <TableCell>
                      {(row.status === 'unused' || row.status === 'expired') && (
                        <Button variant="outline" size="sm" disabled={busy === row.id} onClick={() => void revoke(row)}>Revoke</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {list.hasNextPage && (
              <Button variant="outline" size="sm" style={{ marginTop: 10 }} disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
