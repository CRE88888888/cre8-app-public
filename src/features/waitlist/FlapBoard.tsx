import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Waitlist 右邊的翻牌看板（使用者 2026-11-16 選 B、淺色）。翻牌是 CRE8 正式 logo（翻牌 8）的語言：
 * 每一格是一張上下對開的翻牌，換字時像機場看板一樣一張一張翻過去，直到停在新的字。
 *
 * 內容只寫資產代號與策略名稱（產品能做的事），不放報酬、權重這類看起來像真實數字的資料。
 * 偶爾整排翻成「CRE8」。系統設定「減少動態」時不翻，只顯示固定的一面。
 */

/** 翻牌上的字元順序：換字時從目前的字往後翻到目標字。 */
const FLAPS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789·';
const ASSET_WIDTH = 6;
const PLAY_WIDTH = 5;

/** 看板會輪流出現的資產（加密與美股代幣）與策略。 */
export const BOARD_ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'NVDA', 'TSLA', 'AAPL', 'XAUT', 'DOGE', 'LINK', 'AMZN', 'GOOGL', 'XRP', 'MSFT', 'META', 'ADA'] as const;
export const BOARD_PLAYS = ['HOLD', 'STACK', 'DIPS', 'RANGE', 'TREND'] as const;

export type BoardRow = { asset: string; play: string };

const pad = (text: string, width: number): string => text.toUpperCase().slice(0, width).padEnd(width, ' ');

/** 一排的文字（資產欄＋策略欄），固定寬度。 */
export function rowText(row: BoardRow): string {
  return pad(row.asset, ASSET_WIDTH) + pad(row.play, PLAY_WIDTH);
}

/** 從 `from` 翻到 `to` 要經過的字（不含起點、含終點）；不在翻牌上的字直接跳到終點。 */
export function flapPath(from: string, to: string): string[] {
  const start = FLAPS.indexOf(from), end = FLAPS.indexOf(to);
  if (from === to) return [];
  if (start < 0 || end < 0) return [to];
  const path: string[] = [];
  for (let i = (start + 1) % FLAPS.length; ; i = (i + 1) % FLAPS.length) {
    path.push(FLAPS[i] as string);
    if (i === end) return path;
  }
}

/** 初始看板：前幾個資產各配一個策略，第一排是 CRE8。 */
export function initialRows(count: number): BoardRow[] {
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? { asset: 'CRE8', play: 'FUNDS' } : { asset: BOARD_ASSETS[index % BOARD_ASSETS.length] as string, play: BOARD_PLAYS[index % BOARD_PLAYS.length] as string },
  );
}

/** 下一次要換的那一排與新內容：不跟看板上已有的資產重複；大約每 6 次有一次整排翻成 CRE8。 */
export function nextChange(rows: readonly BoardRow[], random: () => number = Math.random): { index: number; row: BoardRow } {
  const index = Math.floor(random() * rows.length) % rows.length;
  if (random() < 0.16 && !rows.some((row) => row.asset === 'CRE8')) return { index, row: { asset: 'CRE8', play: 'FUNDS' } };
  const shown = new Set(rows.map((row) => row.asset));
  const choices = BOARD_ASSETS.filter((asset) => !shown.has(asset));
  const asset = choices[Math.floor(random() * choices.length) % Math.max(1, choices.length)] ?? BOARD_ASSETS[0];
  const play = BOARD_PLAYS[Math.floor(random() * BOARD_PLAYS.length) % BOARD_PLAYS.length] as string;
  return { index, row: { asset, play } };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 一格翻牌：字變了就一張一張翻到新字（每張約 60ms），每翻一張播一次對開動畫。 */
function Flap({ char, still }: { char: string; still: boolean }): ReactNode {
  const [shown, setShown] = useState(char);
  const [tick, setTick] = useState(0);
  const shownRef = useRef(char);
  useEffect(() => {
    if (still) {
      shownRef.current = char;
      setShown(char);
      return;
    }
    const path = flapPath(shownRef.current, char);
    if (path.length === 0) return;
    let step = 0;
    const timer = window.setInterval(() => {
      const next = path[step] as string;
      shownRef.current = next;
      setShown(next);
      setTick((value) => value + 1);
      step += 1;
      if (step >= path.length) window.clearInterval(timer);
    }, 60);
    return () => window.clearInterval(timer);
  }, [char, still]);
  return (
    <span className="flap" data-blank={shown === ' ' ? '' : undefined}>
      <span className="flap__face" key={tick}>{shown === ' ' ? ' ' : shown}</span>
    </span>
  );
}

/**
 * 整面看板。`rows` 排數（桌面 8、手機 3）。每 1.8 秒換一排；每一格從原本的字一路翻到新字，離得遠的格子翻得久，所以一排會陸續停下。
 */
export function FlapBoard({ rows: count = 8, intervalMs = 1_800 }: { rows?: number; intervalMs?: number }): ReactNode {
  const still = useMemo(prefersReducedMotion, []);
  const [rows, setRows] = useState<BoardRow[]>(() => initialRows(count));
  useEffect(() => {
    setRows(initialRows(count));
  }, [count]);
  useEffect(() => {
    if (still) return;
    const timer = window.setInterval(() => {
      setRows((current) => {
        const { index, row } = nextChange(current);
        return current.map((item, i) => (i === index ? row : item));
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [still, intervalMs]);
  return (
    <div className="flap-board" role="img" aria-label="CRE8 board: assets and the strategies a fund can run on them">
      <div className="flap-board__head" aria-hidden="true">
        <span>Asset</span>
        <span>Strategy</span>
      </div>
      {rows.map((row, index) => (
        <div className="flap-board__row" key={index} aria-hidden="true">
          {[...rowText(row)].map((char, column) => (
            <Flap key={column} char={char} still={still} />
          ))}
        </div>
      ))}
    </div>
  );
}
