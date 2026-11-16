#!/usr/bin/env node
/**
 * 從 cre8-contracts 的 `deployments/testnet-97.json` 重新產生 `src/lib/testnet-97.ts`（地址簿）。
 *
 * 用法（manifest 先從 cre8-contracts 的指定 commit 取出，不讀別人的工作目錄）：
 *
 *   git -C ../cre8-contracts fetch origin
 *   git -C ../cre8-contracts show <commit>:deployments/testnet-97.json > /tmp/testnet-97.json
 *   node scripts/gen-testnet-97.mjs /tmp/testnet-97.json <commit>
 *
 * 只讀 manifest、只寫 `src/lib/testnet-97.ts`，不連網、不碰鏈。產生後跑 `bun test tests` 確認
 * （`tests/testnet-97.test.ts` 會核對數量與格式；地址一致性檢查在送交易前再和後端 `/platform/status` 比對）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONTRACT_KEYS = ['registry', 'router', 'executor', 'yieldRegistry', 'yieldView', 'usdt', 'paymaster', 'gasPolicy', 'entryPoint', 'universalRouter', 'permit2'];
const PROTOCOL = { Venus: 'venus', Lista: 'lista', Aave: 'aave_v3' };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  console.error(`gen-testnet-97: ${message}`);
  process.exit(1);
}

/** manifest 的原始位元組 → 地址簿原始碼。格式不對就丟錯（不產生半套）。 */
export function renderAddressBook(bytes, commit) {
  if (!SHA.test(commit)) throw new Error('commit must be a full 40-character sha');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const m = JSON.parse(bytes.toString('utf8'));
  if (m.chainId !== 97) throw new Error('manifest chainId must be 97');
  for (const key of ['mode', 'generatedAt']) if (typeof m[key] !== 'string') throw new Error(`manifest ${key} missing`);
  if (!Number.isSafeInteger(m.verifiedAtBlock)) throw new Error('manifest verifiedAtBlock missing');
  if (typeof m.gitCommit !== 'string' || !SHA.test(m.gitCommit)) throw new Error('manifest gitCommit missing');
  for (const key of CONTRACT_KEYS) if (!ADDRESS.test(m.contracts?.[key] ?? '')) throw new Error(`contracts.${key} missing`);
  const assets = Object.entries(m.assets ?? {}).map(([symbol, entry]) => [symbol, entry?.token]);
  for (const [symbol, token] of assets) if (!/^[A-Za-z0-9]+$/.test(symbol) || !ADDRESS.test(token ?? '')) throw new Error(`asset ${symbol} invalid`);
  assets.sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  const markets = (m.yieldMarkets ?? []).map((row) => {
    const protocol = PROTOCOL[row?.protocol];
    if (protocol === undefined || typeof row.symbol !== 'string' || !ADDRESS.test(row.asset ?? '') || !ADDRESS.test(row.receipt ?? '') || !BYTES32.test(row.marketId ?? '')) {
      throw new Error(`yield market ${row?.protocol} ${row?.symbol} invalid`);
    }
    return { id: `${protocol}_${row.symbol.toLowerCase()}`, protocol, symbol: row.symbol, asset: row.asset, receipt: row.receipt, marketId: row.marketId };
  });
  const lines = [
    '/**',
    ' * BSC 測試網（chain 97）的合約地址簿（cre8-app#62）。',
    ' *',
    ' * **產生的檔案，不要手改。** 來源：`CRE8Finance/cre8-contracts` 的 `deployments/testnet-97.json`',
    ` *   - repo commit：\`${commit}\``,
    ` *   - 檔案 sha256：\`${sha256}\``,
    ` *   - manifest 自己記的合約程式 commit（\`gitCommit\`）：\`${m.gitCommit}\``,
    ` *   - \`mode: "${m.mode}"\`、\`verifiedAtBlock: ${m.verifiedAtBlock}\`、\`generatedAt: ${m.generatedAt}\``,
    ' *',
    ...(m.mode === 'public'
      ? [' * `mode: "public"` 表示這些地址已公開部署在 chain 97，並逐一用 eth_getCode 驗證過（cre8-contracts manifest）。']
      : [' * `mode: "fork"` 表示這些地址是在本機 chain 97 fork 上驗證的；合約全部用 CREATE2 部署，',
        ' * 公開部署會落在同樣的地址（cre8-contracts `docs/testnet-97.zh-TW.md` 第 1 節）。']),
    ' * 合約重新部署（程式或建構參數有變）地址就會換：那時要重新產生這個檔案。',
    ' *',
    ` * 這裡只留前端用得到的欄位（合約、${assets.length} 個模擬資產的代幣地址）；角色、池子、oracle 不放。`,
    ' * 生息市場只留固定身分（核對用）；APR 等動態資料從後端市場清單 API 來。',
    ' */',
    'export const TESTNET_97 = {',
    '  chainId: 97,',
    '  source: {',
    "    repo: 'CRE8Finance/cre8-contracts',",
    "    path: 'deployments/testnet-97.json',",
    `    commit: '${commit}',`,
    `    sha256: '${sha256}',`,
    `    mode: '${m.mode}',`,
    `    verifiedAtBlock: ${m.verifiedAtBlock},`,
    '  },',
    '  contracts: {',
    ...CONTRACT_KEYS.map((key) => `    ${key}: '${m.contracts[key]}',`),
    '  },',
    `  /** 測試 USDT 之外的 ${assets.length} 個模擬資產：symbol → 代幣地址。 */`,
    '  assets: {',
    ...assets.map(([symbol, token]) => `    ${symbol}: '${token}',`),
    '  },',
    '  /**',
    `   * ${markets.length} 個生息市場的固定身分（\`yieldMarkets[]\`）：平台 id 照後端 \`yield-domain.ts\` 的 \`\${protocol}_\${symbol 小寫}\`。`,
    '   * 簽名前核對後端市場清單用（slug、協議、資產、收據、marketId 要整組相同）；APR 等動態資料不放這裡。',
    '   */',
    '  yieldMarkets: [',
    ...markets.map((x) => `    { id: '${x.id}', protocol: '${x.protocol}', symbol: '${x.symbol}', asset: '${x.asset}', receipt: '${x.receipt}', marketId: '${x.marketId}' },`),
    '  ],',
    '} as const;',
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [manifestPath, commit] = process.argv.slice(2);
  if (!manifestPath || !commit) fail('usage: node scripts/gen-testnet-97.mjs <manifest.json> <cre8-contracts commit>');
  try {
    const out = renderAddressBook(readFileSync(manifestPath), commit);
    writeFileSync(new URL('../src/lib/testnet-97.ts', import.meta.url), out);
    console.log('wrote src/lib/testnet-97.ts');
  } catch (error) {
    fail(error.message);
  }
}
