/**
 * 模式 B（dev 私鑰）——**整支檔案只存在於 dev build**。
 *
 * `src/main.ts` 用 `DEV_WALLET_ENABLED`（`import.meta.env.DEV` ＋ hostname 檢查）包住
 * `void import('./dev.js')`。production `vite build` 時 `import.meta.env.DEV` 是 `false`，
 * Rollup 把整個分支判死，這個動態 import 不會產生任何 chunk，於是：
 *   - `privateKeyToAccount`（`viem/accounts`）不會被拉進 bundle
 *   - `#dev-private-key` 輸入框、「顯示 dev 模式（B）」按鈕都不會出現在 HTML/JS
 * 但 dev build 的功能完全保留（本機測試要它），只是「production 產物裡不存在」。
 *
 * 少了 `import.meta.env.DEV` 那一半也還有一層保險：hostname 不是本機就不 render（見 main.ts）。
 */
import {
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AppConfig } from './config.js';
import { setBadge, type Trace } from './log.js';
import { chainFor, type WalletConnection } from './wallet.js';

export type DevModeHandle = {
  /** 「清空狀態」時把輸入框一起清掉（私鑰不留在 DOM 裡）。 */
  clear: () => void;
};

export type DevModeDeps = {
  /** 「1 · 連線」的按鈕列：展開按鈕插在這裡。 */
  actions: HTMLElement;
  /** 按鈕列下方的空容器：面板插在這裡。 */
  extra: HTMLElement;
  walletBadge: HTMLElement;
  trace: Trace;
  readConfig: () => AppConfig;
  /** 連線成功後交回 main.ts（同一條接管路徑，模式 A/B 之後的行為一致）。 */
  onConnected: (connection: WalletConnection, extra: string, badgeText: string) => void;
};

/** 模式 B：dev 私鑰（本機 anvil fork 專用）。金鑰只活在這個 function 的參數與回傳物件裡。 */
function connectDevPrivateKey(rawKey: string, chain: Chain, rpcUrl: string): WalletConnection {
  const trimmed = rawKey.trim();
  if (trimmed === '') throw new Error('私鑰是空的');
  const normalized = (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`私鑰格式不對：要 32 bytes hex（66 字元含 0x），拿到 ${normalized.length} 字元`);
  }
  const account = privateKeyToAccount(normalized);
  return {
    mode: 'dev',
    address: account.address,
    chain,
    walletClient: createWalletClient({ account, chain, transport: http(rpcUrl) }) as unknown as WalletClient<
      Transport,
      Chain,
      Account
    >,
  };
}

/**
 * 掛上 dev 面板。呼叫端只有在 `DEV_WALLET_ENABLED` 為 true 時才會呼叫它，
 * 所以這裡不需要（也不該）自己再做「要不要顯示」的判斷 —— 不該顯示時連 DOM 都不會建。
 */
export function mountDevMode(deps: DevModeDeps): DevModeHandle {
  const toggle = document.createElement('button');
  toggle.id = 'btn-toggle-dev';
  toggle.className = 'ghost';
  toggle.textContent = '顯示 dev 模式（B）';

  const panel = document.createElement('div');
  panel.id = 'dev-panel';
  panel.className = 'hidden';

  const warn = document.createElement('div');
  warn.className = 'warn';
  warn.append(
    document.createTextNode('⚠ dev 私鑰模式：只給本機 anvil fork 使用，絕不可用於真實資產。'),
    document.createElement('br'),
    document.createTextNode(
      '私鑰只存在這個頁面的記憶體裡，不會寫入 localStorage / cookie / 任何儲存，重新整理即消失。',
    ),
  );

  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.append(document.createTextNode('anvil 私鑰（0x…，本機用）'));
  const input = document.createElement('input');
  input.id = 'dev-private-key';
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  label.append(input);
  const connect = document.createElement('button');
  connect.id = 'btn-connect-dev';
  connect.textContent = 'B · 用私鑰連線';
  row.append(label, connect);

  panel.append(warn, row);
  deps.actions.append(toggle);
  deps.extra.append(panel);

  toggle.addEventListener('click', () => {
    const hidden = panel.classList.toggle('hidden');
    toggle.textContent = hidden ? '顯示 dev 模式（B）' : '收合 dev 模式（B）';
  });

  connect.addEventListener('click', () => {
    setBadge(deps.walletBadge, 'run', '連線中');
    deps.trace.step('模式 B：用 anvil 私鑰建立本地簽章者');
    try {
      const cfg = deps.readConfig();
      const connection = connectDevPrivateKey(input.value, chainFor(cfg.chainId, cfg.rpcUrl), cfg.rpcUrl);
      // 金鑰立刻從 DOM 清掉，只留在記憶體中的 account 物件裡。
      input.value = '';
      deps.trace.ok('privateKeyToAccount', connection.address);
      deps.onConnected(
        connection,
        '⚠ dev 私鑰只用於本機 anvil fork；簽章在瀏覽器本地完成（EIP-191）。',
        'B · dev 私鑰',
      );
    } catch (err) {
      setBadge(deps.walletBadge, 'fail');
      deps.trace.fail('模式 B 連線', err);
    }
  });

  return {
    clear: () => {
      input.value = '';
    },
  };
}
