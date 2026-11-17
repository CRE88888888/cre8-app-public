import type { ReactNode } from 'react';
import type { StrategyVersion } from '../../lib/api';
import type { VersionSchedule } from '../../lib/atp-contracts';
import { FOLLOW_VERSIONS_PLAIN, FOLLOW_VERSIONS_SHORT } from '../../lib/atp-contracts';
import { PUBLISH_RULES, assetPlays, changeLine, nextPublishAt, versionChanges, whenText, type AssetPlay } from '../../lib/fund-versions';

/** 後端版本裡 activeAt 跟鏈上（unix 秒）相同的那一版的逐資產買法。找不到就 null（只說「買法有變」）。 */
function playsAt(versions: readonly StrategyVersion[] | undefined, activeAt: number): AssetPlay | null {
  const match = (versions ?? []).find((version) => version.activeAt !== null && Math.floor(Date.parse(version.activeAt) / 1000) === activeAt);
  return match === undefined ? null : assetPlays(match.execution);
}

/**
 * 基金頁的版本通知（P11，cre8-contracts#54）：有待生效版本時，寫出生效時間與變更（資產、權重、每個資產的策略、績效費），
 * 持有人有「不同意，退出」入口（沿用 Sell 分頁的全部賣出／原樣轉出），建立者有取消按鈕。
 * 第一版也要等 24 小時：還沒有生效版本時寫開放買入的時間。
 */
export function VersionNotice({
  schedule,
  versions,
  symbolOf,
  onExit,
  creator,
}: {
  schedule: VersionSchedule;
  versions: readonly StrategyVersion[] | undefined;
  symbolOf: (asset: string) => string;
  /** 持有人才有：切到 Sell 分頁。 */
  onExit: (() => void) | null;
  /** 建立者才有。 */
  creator: { onCancel: () => void; cancelling: boolean } | null;
}): ReactNode {
  const { active, pending } = schedule;
  const cancel = creator === null ? null : (
    <>
      <p className="fine">{PUBLISH_RULES.cancel}</p>
      <button type="button" className="btn ghost" disabled={creator.cancelling} onClick={creator.onCancel}>
        {creator.cancelling ? 'Cancelling…' : 'Cancel the new settings'}
      </button>
    </>
  );
  if (pending === null) {
    if (creator === null || active === null) return null;
    const next = nextPublishAt(schedule.lastPublishedAt);
    return next * 1000 > Date.now() ? (
      <p className="fine" data-entry="next-publish">You can publish new settings again on {whenText(next)}, 7 days after the last publish.</p>
    ) : null;
  }
  if (active === null) {
    return (
      <div data-entry="pending-version" role="status">
        <p className="fine warn"><b>This fund opens for buying on {whenText(pending.activeAt)}.</b> New settings take effect 24 hours after they are published.</p>
        {cancel}
      </div>
    );
  }
  const before = playsAt(versions, active.activeAt);
  const after = playsAt(versions, pending.activeAt);
  const changes = versionChanges(active, pending, before !== null && after !== null ? { active: before, next: after } : null);
  return (
    <div data-entry="pending-version" role="status">
      <p className="fine warn"><b>New settings take effect on {whenText(pending.activeAt)}.</b> Accounts in this fund follow them automatically.</p>
      {changes.length > 0 && (
        <ul className="fine" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {changes.map((change, index) => <li key={index}>{changeLine(change, symbolOf)}</li>)}
        </ul>
      )}
      {onExit !== null && (
        <p className="fine">
          Don’t agree?{' '}
          <button type="button" className="link-button" onClick={onExit}>Exit before then</button>: sell everything to USDT, or withdraw your assets without selling.
        </p>
      )}
      {cancel}
    </div>
  );
}

/** 第一次買入（加入基金）前顯示的同意條款白話版；原文（簽名同意的那一段）收在細節裡。 */
export function FollowVersionsTerms({ terms }: { terms: string }): ReactNode {
  return (
    <div data-entry="follow-versions-terms">
      {/* 使用者 2026-11-17：提示太吵。只留一句重點，完整白話版與簽名原文收在 Details 裡。 */}
      <details className="fine">
        <summary>{FOLLOW_VERSIONS_SHORT}</summary>
        <p className="fine">{FOLLOW_VERSIONS_PLAIN.follow}</p>
        <p className="fine">{FOLLOW_VERSIONS_PLAIN.feeCut}</p>
        <p className="fine">What you sign:</p>
        <p className="mono">{terms}</p>
      </details>
    </div>
  );
}
