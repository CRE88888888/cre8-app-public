import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { pct } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import type { FundArt } from "../../lib/fund-art";
import { fundHoldings } from "./FundBoard";

/**
 * 基金列表的一張卡（2026-11-20 改版，照新版首頁的 `.sc`／`.pc`）：
 * - 有版畫：色板（淺色黃、深色深灰）＋版畫，襯線名稱在左上、報酬在左下。人物也是版畫，圖比較大。
 * - 沒有圖：只有色板＋名稱。
 * 數字是後端的推估年化（APY）；歷史不夠的基金是「—」（不顯示模擬數字）。
 */
export function FundTile({ fund, art, url, apy, note }: {
  fund: ReferenceFund;
  art: FundArt | null;
  url: string;
  /** 後端的推估年化（`modelReturns.annualized`，見 `lib/model-history.ts`）；沒有就是「—」。 */
  apy: { apy: number; asOf: string } | null;
  /** 只給螢幕閱讀器的補充（例如 High risk）；畫面上不顯示小字。 */
  note?: string;
}): ReactNode {
  const holdings = fundHoldings(fund).slice(0, 3).map((row) => row.label).join(" · ");
  const tone = apy === null ? "" : apy.apy >= 0 ? "pos" : "neg";
  const kind = art === null ? "plain" : art.srcDark ? "person" : "ink";
  return (
    <li className={`lp-tile lp-tile--${kind}`} data-slug={fund.slug}>
      <Link to={url} className="lp-tile-link" viewTransition>
        {art && <span className="lp-ink" aria-hidden="true" style={artStyle(art)} />}
        <h3 className="lp-tile-name">{fund.name}</h3>
        {/* 卡片上只有名稱和報酬（使用者 2026-11-20：不要小字）；報酬是什麼、成分有哪些，給螢幕閱讀器與滑過提示。 */}
        <p className="lp-tile-foot" title={apy === null ? holdings || undefined : `Estimated APY from model history to ${apy.asOf}${holdings ? `. ${holdings}` : ""}`}>
          <b className={tone}>{apy === null ? "—" : <>{pct(apy.apy)}<small> APY</small></>}</b>
          <span className="sr-only">{apy === null ? "Estimated APY not available yet" : "Estimated APY"}{note ? `, ${note}` : ""}{holdings ? `. Holdings: ${holdings}` : ""}</span>
        </p>
      </Link>
    </li>
  );
}

/** 版畫遮罩的 CSS 變數；人物多一張深色版用的反相遮罩。 */
export function artStyle(art: FundArt): CSSProperties {
  return { "--src": `url(${art.src})`, ...(art.srcDark ? { "--src-dark": `url(${art.srcDark})` } : {}) } as CSSProperties;
}
