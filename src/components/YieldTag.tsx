import type { ReactNode } from 'react';
import { Badge } from './ui';
import { SIMULATED_RATE_LABEL, SIMULATED_RATE_NOTE, marketLabel } from '../lib/yield';
import type { YieldMarket } from '../lib/yield';

/** 「模擬利率」標記：測試網的模擬市場一律顯示（C3 要求），滑過看說明。 */
export function SimulatedRate(): ReactNode {
  return (
    <span title={SIMULATED_RATE_NOTE}>
      <Badge tone="warn">{SIMULATED_RATE_LABEL}</Badge>
    </span>
  );
}

/** 一個市場：`Venus · 5.00%`，模擬市場加上標記。 */
export function YieldTag({ market }: { market: YieldMarket }): ReactNode {
  return (
    <span className="yield-tag">
      {marketLabel(market)}
      {market.simulated && <> <SimulatedRate /></>}
    </span>
  );
}
