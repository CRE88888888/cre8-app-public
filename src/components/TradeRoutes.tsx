import { hasVenue, tradeRoutes } from '../lib/venues';
import type { RoutedStep } from '../lib/venues';

/**
 * 每一步交易走了哪個交易場所（cre8-app#47，A11）：`USDT → DOGE   KyberSwap`。
 *
 * 沒有任何一步知道場所（舊後端沒有 `venue`）時整塊不顯示 —— 這一塊只回答「走哪裡」。
 * `compact`：放在表格的儲存格裡用，不要標題。
 */
export function TradeRoutes({ steps, symbolOf, title = 'Where it traded', compact = false }: {
  steps: readonly RoutedStep[];
  symbolOf: (asset: string) => string;
  title?: string;
  compact?: boolean;
}) {
  if (!hasVenue(steps)) return null;
  const rows = tradeRoutes(steps, symbolOf);
  return (
    <div className={compact ? 'trade-routes is-compact' : 'trade-routes'}>
      {!compact && <p className="trade-routes-title">{title}</p>}
      <ul aria-label={compact ? title : undefined}>
        {rows.map((row) => (
          <li key={`${row.from}>${row.to}@${row.venue ?? ''}`}>
            <span className="trade-routes-pair">
              {row.from} → {row.to}{row.count > 1 ? <span className="trade-routes-count"> ×{row.count}</span> : null}
            </span>
            <span className="trade-routes-venue">{row.venue ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
