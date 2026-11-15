import { describeExecutionProblem, designExecution, type ExecutionKind } from "./fund-execution";
import { PLAYS, type Play } from "../reference/lib/fund-builder";
import {
  reviveBuilder,
  assetOf,
  cashShare,
  DRAFT_STORAGE_KEY,
} from "../reference/lib/fund-builder";
import { IS_TESTNET, testnetToken } from "./testnet-catalogue";
export type ActivationDesign = {
  name: string;
  weights: Record<string, number>;
  symbols: Record<string, string>;
  /** 設計收斂成的模式（cre8-app#79）；收斂不了是 null，原因在 `executionProblem`。 */
  execution: ExecutionKind | null;
  /** 要先回設計器改的事（混合、還沒開放的策略或附加設定）；沒有就是 null。 */
  executionProblem: string | null;
};
// 草稿僅作為表單輸入；資產仍須與登入後 API 的確切地址核對，不能直接成為交易授權。
/**
 * 設計器的資產用主網地址當 key。部署在 BSC 測試網時（cre8-app#86），用鏈上符號換成測試網的代幣地址，
 * 建立頁才對得上後端回來的測試網資產清單；測試網沒有的資產維持主網地址，建立頁會把它列成不能用。
 */
const tokenFor = (symbol: string, mainnet: string, testnet: boolean): string =>
  (testnet ? testnetToken(symbol) ?? mainnet : mainnet).toLowerCase();
export function activationDesign(value: unknown, testnet: boolean = IS_TESTNET): ActivationDesign | null {
  const design = reviveBuilder(value, "demo");
  if (!design || !design.rows.length) return null;
  const weights: Record<string, number> = {},
    symbols: Record<string, string> = {};
  for (const row of design.rows) {
    const asset = assetOf(row.key),
      token = tokenFor(asset.symbol, asset.token, testnet);
    weights[token] = (weights[token] || 0) + Math.round(row.share * 100) / 100;
    symbols[token] = asset.symbol;
  }
  const cash = Math.round(cashShare(design.rows) * 100) / 100;
  if (cash > 0) {
    const token = tokenFor("USDT", "0x55d398326f99059ff775485246999027b3197955", testnet);
    weights[token] = (weights[token] || 0) + cash;
    symbols[token] = "USDT";
  }
  const execution = designExecution(design.rows, design.rules, (play) => PLAYS[play as Play]?.name ?? play);
  return {
    name: design.name,
    weights,
    symbols,
    execution: "kind" in execution ? execution.kind : null,
    executionProblem: "problem" in execution ? describeExecutionProblem(execution.problem) : null,
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
