import { describeExecutionProblem, designExecution, type AssetExecution, type Rebalance } from "./fund-execution";
import { PLAYS, type Play } from "../reference/lib/fund-builder";
import {
  reviveBuilder,
  assetOf,
  cashShare,
  displayAssetSymbol,
  DRAFT_STORAGE_KEY,
} from "../reference/lib/fund-builder";
import { IS_TESTNET, testnetToken } from "./testnet-catalogue";
import "./testnet-assets";
import { CASH_PICK, readYieldPicks } from "./yield";
export type ActivationDesign = {
  name: string;
  weights: Record<string, number>;
  symbols: Record<string, string>;
  /** 每個資產（代幣地址，小寫）的執行設定（G0-4）；換不了是 null，原因在 `executionProblem`。USDT 不在裡面。 */
  executions: Record<string, AssetExecution> | null;
  /** 整檔再平衡（只有全部 hold 才可能不是 none）；換不了是 null。 */
  rebalance: Rebalance | null;
  /** 要先回設計器改的事（還沒開放的策略、附加設定、排程、同資產兩種設定）；沒有就是 null。 */
  executionProblem: string | null;
  /** 每個資產（代幣地址，小寫，含 USDT）選的平台市場 id（APP-3）；沒選的不在裡面。 */
  yields: Record<string, string>;
};
// 草稿僅作為表單輸入；資產仍須與登入後 API 的確切地址核對，不能直接成為交易授權。
/**
 * 設計器的資產用主網地址當 key。部署在 BSC 測試網時（cre8-app#86），用鏈上符號換成測試網的代幣地址，
 * 建立頁才對得上後端回來的測試網資產清單；測試網沒有的資產維持主網地址，建立頁會把它列成不能用。
 */
const tokenFor = (symbol: string, mainnet: string, testnet: boolean): string =>
  (testnet ? testnetToken(symbol) ?? mainnet : mainnet).toLowerCase();
export function activationDesign(value: unknown, testnet: boolean = IS_TESTNET, now: Date = new Date()): ActivationDesign | null {
  const design = reviveBuilder(value, "demo");
  if (!design || !design.rows.length) return null;
  const weights: Record<string, number> = {},
    symbols: Record<string, string> = {};
  const tokenOf = (key: string): string => { const asset = assetOf(key); return tokenFor(asset.symbol, asset.token, testnet); };
  for (const row of design.rows) {
    const asset = assetOf(row.key),
      token = tokenOf(row.key);
    weights[token] = (weights[token] || 0) + Math.round(row.share * 100) / 100;
    symbols[token] = asset.symbol;
  }
  const cash = Math.round(cashShare(design.rows) * 100) / 100;
  const cashToken = tokenFor("USDT", "0x55d398326f99059ff775485246999027b3197955", testnet);
  if (cash > 0) {
    weights[cashToken] = (weights[cashToken] || 0) + cash;
    symbols[cashToken] = "USDT";
  }
  // 參考設計的 reviveBuilder 不認得 `yieldPicks`，所以從原始 JSON 讀（lib/yield.ts）。只留設計裡還有的資產。
  const yields: Record<string, string> = {};
  for (const [key, market] of Object.entries(readYieldPicks(value))) {
    if (key === CASH_PICK) { if (cash > 0) yields[cashToken] = market; }
    else if (design.rows.some((row) => row.key === key)) yields[tokenOf(key)] = market;
  }
  const execution = designExecution(design.rows, {
    rules: design.rules,
    playName: (play) => PLAYS[play as Play]?.name ?? play,
    assetName: (key) => displayAssetSymbol(assetOf(key).symbol),
    now,
  });
  return {
    name: design.name,
    weights,
    symbols,
    executions: "assets" in execution ? Object.fromEntries([...execution.assets].map(([key, setting]) => [tokenOf(key), setting])) : null,
    rebalance: "assets" in execution ? execution.rebalance : null,
    executionProblem: "problem" in execution ? describeExecutionProblem(execution.problem) : null,
    yields,
  };
}
export function savedActivationDesign(): ActivationDesign | null {
  try {
    return activationDesign(
      JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || "null"),
    );
  } catch {
    return null;
  }
}
