import type { ReactNode } from "react";
import type { ReferenceFund } from "../../lib/public-funds";
import { fundHoldings } from "../vaults/FundBoard";

const REBALANCE: Record<string, string> = {
  monthly: "Rebalances monthly",
  drift: "Rebalances when weights drift",
  monthly_drift: "Rebalances monthly and when weights drift",
  source: "Follows source updates",
};

/**
 * 交易面板下方的「你會買到什麼」：買入前不必往下捲到持倉表，就知道這筆錢會變成哪些資產。
 * 只讀模型持倉，不碰任何錢包或交易狀態。
 */
export function FundSnapshot({ fund }: { fund: ReferenceFund }): ReactNode {
  const holdings = fundHoldings(fund);
  if (holdings.length === 0) return null;
  const head = holdings.slice(0, 5);
  const rest = holdings.slice(5).reduce((sum, row) => sum + row.weight, 0);
  const cadence = REBALANCE[fund.backtest?.rebalance ?? ""];
  return (
    <section className="snap" aria-label="What you get">
      <h2>What you get</h2>
      <p className="snap-lead">
        Your USDT is split across {holdings.length} {holdings.length === 1 ? "asset" : "assets"}
        {cadence ? `. ${cadence}.` : "."}
      </p>
      <span className="snap-bar" aria-hidden="true">
        {head.map((row) => <i key={row.symbol} style={{ flexGrow: row.weight }} />)}
        {rest > 0.5 && <i className="snap-bar-rest" style={{ flexGrow: rest }} />}
      </span>
      <ul className="snap-list" role="list">
        {head.map((row) => (
          <li key={row.symbol}>
            {row.logo ? <img src={row.logo} alt="" width="20" height="20" loading="lazy" /> : <span className="snap-dot" />}
            <span>{row.label}</span>
            <b>{row.weight.toFixed(1)}%</b>
          </li>
        ))}
        {holdings.length > head.length && (
          <li className="snap-more">
            <span className="snap-dot" />
            <span>{holdings.length - head.length} more</span>
            <b>{rest.toFixed(1)}%</b>
          </li>
        )}
      </ul>
    </section>
  );
}
