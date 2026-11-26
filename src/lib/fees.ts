/**
 * 費用（參數總表，2026-11 定案）。畫面與設計匯出都從這裡拿，不直接讀 `src/reference` 的 `FEE`
 * （那份是舊的「存入費 1%、CRE8 另加 10%」模型，留著不改）。
 *
 *   - 換幣費：每一批 max(0.1%, 0.30 USDT)。
 *   - 績效費：建立者設 5–20%（總額）。平台從績效費裡抽 10%，不是另外加。
 *     例：績效費 20% → 平台 2%、建立者 18%（都是「獲利的百分比」）。
 */
export const SWAP_FEE = { bps: 10, minUsdt: '0.30' } as const;
export const PERFORMANCE_FEE = { min: 5, max: 20, default: 10 } as const;
/** 平台分走績效費的比例（績效費的 10%）。 */
export const PLATFORM_SHARE_OF_PERFORMANCE_FEE_BPS = 1_000;

/** 「0.1% per batch, at least 0.30 USDT」。 */
export function swapFeeLabel(cash = 'USDT'): string {
  return `${SWAP_FEE.bps / 100}% per batch, at least ${SWAP_FEE.minUsdt} ${cash}`;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** 建立者設的績效費（獲利的 %）拆成平台與建立者各拿多少（也是獲利的 %）。 */
export function performanceSplit(feePct: number): { total: number; platform: number; creator: number } {
  // 不在這裡夾到 5–20%：設計器的滑桿只給 5–20；展示用的模型數字照原樣拆。
  const total = round2(Math.max(0, feePct));
  const platform = round2((total * PLATFORM_SHARE_OF_PERFORMANCE_FEE_BPS) / 10_000);
  return { total, platform, creator: round2(total - platform) };
}

/** 績效費一行說明：「20% of realized profit · CRE8 keeps 2%, the creator 18%」。 */
export function performanceFeeLine(feePct: number, creator = 'the creator'): string {
  const split = performanceSplit(feePct);
  return `${split.total}% of realized profit · CRE8 keeps ${split.platform}%, ${creator} ${split.creator}%`;
}

/**
 * 設計匯出的費用欄位，換成參數總表的說法。`fundDesign`（reference）原本寫的
 * `platformFeeBps`／`depositFeeBps` 是舊模型，這裡拿掉。
 */
export function designFeeTerms(feePct: number): {
  performanceFeeBps: number;
  platformShareOfPerformanceFeeBps: number;
  swapFee: { bpsPerBatch: number; minimumUsdtPerBatch: string };
} {
  return {
    performanceFeeBps: Math.round(Math.min(PERFORMANCE_FEE.max, Math.max(PERFORMANCE_FEE.min, feePct)) * 100),
    platformShareOfPerformanceFeeBps: PLATFORM_SHARE_OF_PERFORMANCE_FEE_BPS,
    swapFee: { bpsPerBatch: SWAP_FEE.bps, minimumUsdtPerBatch: SWAP_FEE.minUsdt },
  };
}
