import { createSiweMessage } from 'viem/siwe';
import * as api from './api.js';
import { defaultConfig, effectiveBackendBaseUrl, type AppConfig } from './config.js';
import type { DevModeHandle } from './dev.js';
import { Trace, errorText, format, setBadge } from './log.js';
import { executeRenewal } from './renewal.js';
import { discoverProviders, fallbackInjectedProvider, safeIcon, type Eip6963ProviderDetail } from './providers.js';
import { mountStatusPanel } from './status.js';
import {
  chainFor,
  connectInjected,
  readWalletChainId,
  rpcErrorCode,
  switchWalletChain,
  USER_REJECTED_CODE,
  type EthereumProvider,
  type InjectedProviderChoice,
  type WalletConnection,
} from './wallet.js';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`頁面缺少元素 #${id}`);
  return el as T;
}

const els = {
  backend: $<HTMLInputElement>('cfg-backend'),
  rpc: $<HTMLInputElement>('cfg-rpc'),
  chainId: $<HTMLInputElement>('cfg-chain'),
  proxy: $<HTMLInputElement>('cfg-proxy'),
  effective: $<HTMLElement>('cfg-effective'),
  connectInjected: $<HTMLButtonElement>('btn-connect-injected'),
  redetect: $<HTMLButtonElement>('btn-redetect-injected'),
  walletActions: $<HTMLElement>('wallet-actions'),
  walletExtra: $<HTMLElement>('wallet-extra'),
  chainNotice: $<HTMLElement>('chain-notice'),
  chainNoticeText: $<HTMLElement>('chain-notice-text'),
  switchChain: $<HTMLButtonElement>('btn-switch-chain'),
  chainSwitchStatus: $<HTMLElement>('chain-switch-status'),
  injectedPicker: $<HTMLElement>('injected-picker'),
  injectedStatus: $<HTMLElement>('injected-status'),
  reset: $<HTMLButtonElement>('btn-reset'),
  address: $<HTMLElement>('wallet-address'),
  walletBadge: $<HTMLElement>('wallet-mode'),
  login: $<HTMLButtonElement>('btn-login'),
  loginBlocked: $<HTMLElement>('login-blocked'),
  token: $<HTMLElement>('auth-token'),
  authBadge: $<HTMLElement>('auth-status'),
  loadPortfolios: $<HTMLButtonElement>('btn-load-portfolios'),
  portfolioRows: $<HTMLElement>('portfolio-rows'),
  renewalBlocked: $<HTMLElement>('renewal-blocked'),
  renewalCards: $<HTMLElement>('renewal-cards'),
  log: $<HTMLElement>('log'),
};

const trace = new Trace(els.log);

let wallet: WalletConnection | null = null;
let session: api.SessionCredentials | null = null;
let portfolios: api.Portfolio[] = [];
/** dev 模式的控制把手；production build 永遠是 null（整段被 tree-shake 掉）。 */
let devMode: DevModeHandle | null = null;
/** 錢包目前 chainId（十進位）。null = 尚未連線，或模式 B（本地簽章，沒有錢包鏈可切）。 */
let walletChainId: number | null = null;
/**
 * 已展開的「看狀態」列：portfolio id → 那一列 <tr>。
 * 同一個 portfolio 只會有一列；重新載入清單時整張表都會重建，所以那時要把這張 map 一起清掉。
 */
const openStatusRows = new Map<string, HTMLTableRowElement>();

// ---------------------------------------------------------------- config

function readConfig(): AppConfig {
  return {
    backendBaseUrl: els.backend.value.trim() || defaultConfig.backendBaseUrl,
    useDevProxy: els.proxy.checked,
    rpcUrl: els.rpc.value.trim() || defaultConfig.rpcUrl,
    bundlerRelayPath: defaultConfig.bundlerRelayPath,
    chainId: Number.parseInt(els.chainId.value, 10) || defaultConfig.chainId,
    kernelVersion: defaultConfig.kernelVersion,
  };
}

function renderEffectiveConfig(): void {
  const cfg = readConfig();
  const base = effectiveBackendBaseUrl(cfg);
  // 後端有 CORS（backend/README §CORS），所以 proxy 只是 dev 方便選項，不是「沒有它就不能用」。
  const relay = `${base}${cfg.bundlerRelayPath}`;
  els.effective.textContent = cfg.useDevProxy
    ? `API 實際走 ${base}（Vite dev proxy → ${cfg.backendBaseUrl}）｜bundler 一律走後端 relay ${relay}｜RPC ${cfg.rpcUrl}｜chainId ${cfg.chainId}`
    : `API 實際直連 ${base}（後端有 CORS，跨 origin 直連可用）｜bundler 一律走後端 relay ${relay}｜RPC ${cfg.rpcUrl}｜chainId ${cfg.chainId}｜alto v1.2.5 沒有 CORS，瀏覽器不能直連 bundler`;
}

els.backend.value = defaultConfig.backendBaseUrl;
els.rpc.value = defaultConfig.rpcUrl;
els.chainId.value = String(defaultConfig.chainId);
els.proxy.checked = defaultConfig.useDevProxy;
for (const el of [els.backend, els.rpc, els.chainId, els.proxy]) {
  el.addEventListener('input', renderEffectiveConfig);
  el.addEventListener('change', renderEffectiveConfig);
}
// 「預期 chainId」是輸入框決定的，所以改設定也要重算 gate（純渲染，不重讀錢包）。
for (const el of [els.chainId, els.rpc]) el.addEventListener('input', applyChainGate);
renderEffectiveConfig();

// ---------------------------------------------------------------- wallet

function onWalletConnected(connection: WalletConnection, extra: string, badgeText = 'A · 注入錢包'): void {
  wallet = connection;
  // 上一次連線的 chainId 一律作廢：先歸零，等 refreshWalletChain() 重讀到才生效。
  walletChainId = null;
  // 錢包名稱來自 EIP-6963 的 info.name；fallback 時沒有名字，就只顯示地址。
  els.address.textContent =
    connection.providerName === undefined
      ? connection.address
      : `${shorten(connection.address)} (${connection.providerName})`;
  setBadge(els.walletBadge, 'ok', badgeText);
  trace.info(extra);
  els.chainSwitchStatus.textContent = '';
  watchChainEvents(connection.provider);
  applyChainGate();
  els.loadPortfolios.disabled = session === null;
}

// ---------------------------------------------------------------- chain 守門

/**
 * 「錢包鏈 vs 設定鏈」的判定。模式 B 沒有 provider（`walletChainId` 一直是 null），
 * 所以永遠不會被封鎖 —— 模式 B 是在瀏覽器本地簽 EIP-191，沒有錢包鏈可以不符。
 */
type ChainVerdict = { expected: number; actual: number | null; blocked: boolean };

function chainVerdict(): ChainVerdict {
  const expected = readConfig().chainId;
  const actual = wallet === null ? null : walletChainId;
  return { expected, actual, blocked: actual !== null && actual !== expected };
}

function decimalAndHex(chainId: number): string {
  return `${String(chainId)}（0x${chainId.toString(16)}）`;
}

/**
 * 修 1：舊訊息把 personal_sign 寫成與 chain 無關 —— 那是錯的，只有 MetaMask 成立。
 * 實測 Phantom 會直接拒簽 chainId 不符的 SIWE 訊息
 * （`InvalidInputRpcError: The app's signature request cannot be shown as the chain ID does not match…`）。
 * 所以這裡只寫事實，不寫「不影響」。
 */
function chainMismatchMessage(actual: number, expected: number): string {
  return (
    `錢包鏈與預期不符：目前 chainId=${decimalAndHex(actual)}，預期 chainId=${decimalAndHex(expected)}。` +
    '這會直接影響簽名：Phantom 會拒簽 chainId 不符的 SIWE 訊息（InvalidInputRpcError：the chain ID does not match），' +
    'MetaMask 不擋，但使用者是在一條自己沒在用的鏈上簽。' +
    `頁面上有「切換錢包到 chainId ${String(expected)}」可按；切好之前不開放登入與續期。`
  );
}

/** 切鏈請求進行中：applyChainGate 不能在這個期間把按鈕再打開（不然會重複彈錢包）。 */
let switchingChain = false;

/** 續期按鈕是動態產生的，所以每次 gate 變動都要回頭掃一遍（執行中的按鈕由 runRenewalFor 自己管）。 */
function refreshRenewalButtons(blocked: boolean): void {
  for (const button of els.portfolioRows.querySelectorAll<HTMLButtonElement>('button.renew-btn')) {
    if (button.dataset.busy === '1') continue;
    button.disabled = blocked;
  }
}

/**
 * 純渲染：鏈狀態 → 畫面（醒目提示、切換按鈕文案、登入/續期按鈕的 disabled ＋ 旁邊的原因）。
 * 不印日誌 —— 日誌只在「連線」「chainChanged」「切換」這幾個事件點各印一次，不然改個設定就洗版。
 */
function applyChainGate(): void {
  const { expected, actual, blocked } = chainVerdict();

  els.chainNotice.classList.toggle('hidden', !blocked);
  els.loginBlocked.classList.toggle('hidden', !blocked);
  els.renewalBlocked.classList.toggle('hidden', !blocked);

  if (blocked && actual !== null) {
    els.chainNoticeText.textContent = chainMismatchMessage(actual, expected);
    const reason =
      `⚠ 錢包 chainId=${String(actual)} 與預期 ${String(expected)} 不符，已暫時停用：` +
      `請先用上方「1 · 連線」的「切換錢包到 chainId ${String(expected)}」切換（Phantom 之類的錢包會直接拒簽不符的訊息）。`;
    els.loginBlocked.textContent = reason;
    els.renewalBlocked.textContent = reason;
  }
  els.switchChain.textContent = `切換錢包到 chainId ${String(expected)}`;
  els.switchChain.disabled = switchingChain || wallet?.provider === undefined;
  els.login.disabled = wallet === null || blocked;
  refreshRenewalButtons(blocked);
}

/**
 * 重新讀「連線時選定的那個 provider」的 eth_chainId → 更新畫面 →（不符時）印一次事實說明。
 * 不碰 window.ethereum：多錢包環境下它可能是另一個錢包，讀到的鏈不是要簽的那個。
 */
async function refreshWalletChain(): Promise<void> {
  const provider = wallet?.provider;
  walletChainId = null;
  if (provider !== undefined) {
    try {
      const chainId = await readWalletChainId(provider);
      walletChainId = chainId;
      trace.value('錢包 eth_chainId', decimalAndHex(chainId));
    } catch (err) {
      trace.fail('讀錢包 eth_chainId', err);
    }
  }
  applyChainGate();
  const { expected, actual } = chainVerdict();
  if (actual !== null && actual !== expected) trace.info(chainMismatchMessage(actual, expected));
}

let chainEventWatch: { provider: EthereumProvider; handler: (...args: unknown[]) => void } | null = null;

/** 使用者可能自己在錢包裡切鏈，所以 chainChanged 一律重讀 chainId（事件帶的 hex 只當提示）。 */
function watchChainEvents(provider: EthereumProvider | undefined): void {
  if (chainEventWatch !== null) {
    chainEventWatch.provider.removeListener?.('chainChanged', chainEventWatch.handler);
    chainEventWatch = null;
  }
  if (provider === undefined) return;
  const handler = (...args: unknown[]): void => {
    trace.step(`chainChanged（${String(args[0])}）→ 重新讀 eth_chainId`);
    void refreshWalletChain();
  };
  provider.on?.('chainChanged', handler);
  chainEventWatch = { provider, handler };
}

els.switchChain.addEventListener('click', async () => {
  // 一定要用連線時選定的 provider，不能用 window.ethereum。
  const provider = wallet?.provider;
  if (provider === undefined) return;
  const cfg = readConfig();
  switchingChain = true;
  els.switchChain.disabled = true;
  els.chainSwitchStatus.className = 'hint';
  els.chainSwitchStatus.textContent = '切換中…（請在錢包裡確認）';
  try {
    const outcome = await switchWalletChain(provider, cfg.chainId, cfg.rpcUrl, (message) => trace.step(message));
    if (outcome.addedChain) trace.ok('wallet_addEthereumChain', `已加入 chainId=${String(cfg.chainId)}`);
    await refreshWalletChain();
    if (chainVerdict().blocked) {
      els.chainSwitchStatus.textContent = `切換呼叫回報成功，但錢包 eth_chainId 仍是 ${String(walletChainId)} —— 原文見下方日誌`;
      els.chainSwitchStatus.className = 'hint lfail';
    } else {
      trace.ok('切鏈完成', `eth_chainId=${String(walletChainId)}，登入與續期已解除封鎖`);
      els.chainSwitchStatus.textContent = `已切換到 chainId ${String(cfg.chainId)}，登入與續期已解除封鎖`;
      els.chainSwitchStatus.className = 'hint lok';
    }
  } catch (err) {
    // 使用者按「拒絕」也走這裡：原文照印，狀態標「已取消」。
    const rejected = rpcErrorCode(err) === USER_REJECTED_CODE;
    els.chainSwitchStatus.textContent = rejected
      ? '已取消（使用者拒絕切換；原文見下方日誌）'
      : '切換失敗（原文見下方日誌）';
    els.chainSwitchStatus.className = 'hint lfail';
    trace.fail(rejected ? 'wallet_switchEthereumChain（使用者拒絕）' : 'wallet_switchEthereumChain', err);
  } finally {
    switchingChain = false;
    applyChainGate();
  }
});

// ---------------------------------------------------------------- EIP-6963 錢包清單

function walletLabel(detail: Eip6963ProviderDetail): string {
  return `${detail.info.name}（rdns: ${detail.info.rdns}）`;
}

function clearInjectedPicker(): void {
  els.injectedPicker.replaceChildren();
  els.injectedPicker.classList.add('hidden');
  els.injectedStatus.textContent = '';
  els.injectedStatus.className = 'hint';
}

/** 三個以上（含）的其中一個：每個錢包一顆按鈕，有合法 icon 就帶 16×16 圖示。 */
function choiceButton(detail: Eip6963ProviderDetail): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'ghost wallet-choice';
  button.title = walletLabel(detail);
  const icon = safeIcon(detail.info.icon); // 只接受 data:image/ 開頭
  if (icon !== undefined) {
    const img = document.createElement('img');
    img.src = icon;
    img.alt = '';
    img.width = 16;
    img.height = 16;
    button.append(img);
  }
  const name = document.createElement('span');
  name.textContent = detail.info.name;
  button.append(name);
  button.addEventListener('click', () => {
    button.disabled = true;
    void connectInjectedWallet({ provider: detail.provider, name: detail.info.name }, walletLabel(detail)).finally(() => {
      button.disabled = false;
    });
  });
  return button;
}

function renderInjectedList(details: Eip6963ProviderDetail[]): void {
  clearInjectedPicker();
  els.injectedPicker.classList.remove('hidden');
  els.injectedStatus.textContent = `偵測到 ${details.length} 個錢包，選一個連線（按「重新偵測錢包」可重新掃描）：`;
  for (const detail of details) els.injectedPicker.append(choiceButton(detail));
}

function renderNoInjected(): void {
  clearInjectedPicker();
  const fallback = fallbackInjectedProvider();
  els.injectedStatus.className = 'hint lfail';
  els.injectedStatus.textContent =
    fallback === undefined
      ? '沒有偵測到任何瀏覽器錢包'
      : '沒有偵測到任何瀏覽器錢包。window.ethereum 存在，但它可能屬於任何一個錢包。';
  if (fallback === undefined) return;
  // 保底路徑：按下才碰 window.ethereum，按鈕上就明講「不確定是哪個錢包」。
  els.injectedPicker.classList.remove('hidden');
  const button = document.createElement('button');
  button.className = 'danger';
  button.textContent = '用 window.ethereum（不確定是哪個錢包）';
  button.title = 'window.ethereum 只由最後注入的錢包佔用；裝了多個錢包時這可能是別的那個。';
  button.addEventListener('click', () => {
    button.disabled = true;
    void connectInjectedWallet(undefined, 'window.ethereum（fallback，錢包未知）').finally(() => {
      button.disabled = false;
    });
  });
  els.injectedPicker.append(button);
}

/** choice === undefined 代表走 window.ethereum 保底路徑（由 connectInjected 內部判定並標記）。 */
async function connectInjectedWallet(choice: InjectedProviderChoice | undefined, label: string): Promise<void> {
  setBadge(els.walletBadge, 'run', '連線中');
  trace.step(`模式 A：連線 ${label}`);
  try {
    const cfg = readConfig();
    const chain = chainFor(cfg.chainId, cfg.rpcUrl);
    const { connection, chainIdHex } = await connectInjected(chain, choice);
    trace.ok('eth_requestAccounts', connection.address);
    if (connection.providerIsFallback === true) {
      trace.info('⚠ 這次走的是 window.ethereum 保底路徑：無法確認實際是哪一個錢包。');
    }
    trace.value('連線時 eth_chainId', chainIdHex);
    onWalletConnected(connection, `walletClient 已帶 account=${connection.address}（避免 SDK 自行 eth_requestAccounts）`);
    // 連線後立刻再讀一次 eth_chainId（不是只信上次的結果），不符就先擋住登入/續期並給切換按鈕。
    await refreshWalletChain();
  } catch (err) {
    setBadge(els.walletBadge, 'fail');
    trace.fail('模式 A 連線', err);
  }
}

async function detectInjected(): Promise<Eip6963ProviderDetail[]> {
  trace.step('EIP-6963：dispatch eip6963:requestProvider，收集 eip6963:announceProvider');
  const details = await discoverProviders();
  trace.info(
    details.length === 0
      ? 'EIP-6963 沒有任何錢包廣播'
      : `EIP-6963 偵測到 ${details.length} 個：${details.map((d) => `${d.info.name} (${d.info.rdns})`).join('、')}`,
  );
  return details;
}

els.connectInjected.addEventListener('click', async () => {
  els.connectInjected.disabled = true;
  setBadge(els.walletBadge, 'run', '偵測錢包中');
  clearInjectedPicker();
  try {
    const details = await detectInjected();
    if (details.length === 0) {
      renderNoInjected();
      setBadge(els.walletBadge, 'idle', '未連線');
      return;
    }
    if (details.length === 1) {
      // 只有一個就不用讓使用者多點一次。
      const only = details[0];
      await connectInjectedWallet({ provider: only.provider, name: only.info.name }, walletLabel(only));
      return;
    }
    renderInjectedList(details);
    setBadge(els.walletBadge, 'idle', '請選擇錢包');
  } catch (err) {
    setBadge(els.walletBadge, 'fail');
    trace.fail('EIP-6963 偵測', err);
  } finally {
    els.connectInjected.disabled = false;
  }
});

els.redetect.addEventListener('click', async () => {
  els.redetect.disabled = true;
  clearInjectedPicker();
  try {
    const details = await detectInjected();
    if (details.length === 0) renderNoInjected();
    else renderInjectedList(details);
  } catch (err) {
    trace.fail('EIP-6963 重新偵測', err);
  } finally {
    els.redetect.disabled = false;
  }
});

// ---------------------------------------------------------------- dev 模式（production 產物裡不存在）

/**
 * 模式 B 的開關，兩道條件缺一不可：
 *
 * 1. `import.meta.env.DEV`：`vite build` 時是常數 `false`，Rollup 於是把下面那個 `if` 整段判死 ——
 *    動態 import 的 `./dev.js` 不會變成 chunk，那個模組裡的私鑰工具、輸入框與按鈕字樣
 *    都不會進入 production 產物（不是隱藏，是不存在）。
 * 2. hostname 是本機：**這道是保險，不是裝飾**。`vite build --mode development` 會讓
 *    `import.meta.env.DEV` 變成 `true`，那種產物含有活的私鑰輸入框；若被部署到公開網域，
 *    hostname 檢查會讓面板完全不 render（不建 DOM、不綁事件，不是 `display:none`）。
 */
const DEV_WALLET_ENABLED =
  import.meta.env.DEV && /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(window.location.hostname);

if (DEV_WALLET_ENABLED) {
  void import('./dev.js').then((mod) => {
    devMode = mod.mountDevMode({
      actions: els.walletActions,
      extra: els.walletExtra,
      walletBadge: els.walletBadge,
      trace,
      readConfig,
      onConnected: onWalletConnected,
    });
  });
}

els.reset.addEventListener('click', () => {
  wallet = null;
  walletChainId = null;
  session = null;
  portfolios = [];
  els.address.textContent = '—';
  els.token.textContent = '—';
  devMode?.clear();
  openStatusRows.clear();
  els.portfolioRows.innerHTML = '<tr><td colspan="6" class="linfo">尚未載入</td></tr>';
  els.renewalCards.innerHTML = '';
  clearInjectedPicker();
  watchChainEvents(undefined);
  els.chainSwitchStatus.textContent = '';
  els.chainNoticeText.textContent = '';
  els.loginBlocked.textContent = '';
  els.renewalBlocked.textContent = '';
  els.login.disabled = true;
  els.loadPortfolios.disabled = true;
  setBadge(els.walletBadge, 'idle', '未連線');
  setBadge(els.authBadge, 'idle', '未登入');
  applyChainGate();
  trace.clear();
  trace.info('狀態已清空（token 只在記憶體，重新整理即消失）');
});

// ---------------------------------------------------------------- SIWE

els.login.addEventListener('click', async () => {
  if (!wallet || chainVerdict().blocked) return;
  els.login.disabled = true;
  setBadge(els.authBadge, 'run', '簽章中');
  try {
    const cfg = readConfig();
    const base = effectiveBackendBaseUrl(cfg);

    trace.step('POST /auth/nonce');
    const challenge = await api.requestNonce(base);
    trace.ok('nonce challenge', challenge);

    const message = createSiweMessage({
      address: wallet.address,
      chainId: challenge.chainId,
      domain: challenge.domain,
      uri: challenge.uri,
      statement: challenge.statement,
      nonce: challenge.nonce,
      version: challenge.version as '1',
      issuedAt: new Date(challenge.issuedAt),
    });
    trace.value('SIWE 訊息原文（即將簽這個）', message);

    trace.step('錢包簽 SIWE 訊息（personal_sign / EIP-191）');
    const signature = await wallet.walletClient.signMessage({ account: wallet.walletClient.account, message });
    trace.ok('SIWE signature', signature);

    trace.step('POST /auth/login');
    const credentials = await api.requestLogin(base, message, signature);
    session = credentials;
    trace.ok('登入成功', { tokenPrefix: credentials.token.slice(0, 8), tokenLength: credentials.token.length, expiresAt: credentials.expiresAt });
    els.token.textContent = `${credentials.token.slice(0, 8)}…（完整 token 只在記憶體）`;
    setBadge(els.authBadge, 'ok', '已登入');
    els.loadPortfolios.disabled = false;
  } catch (err) {
    setBadge(els.authBadge, 'fail', '登入失敗');
    trace.fail('SIWE 登入', err);
  } finally {
    // 不在這裡無條件打開：跑到一半鏈被切走的話，gate 會繼續擋。
    applyChainGate();
  }
});

// ---------------------------------------------------------------- portfolios

function cell(text: string, mono = false): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (mono) td.className = 'mono';
  return td;
}

function shorten(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * 「看狀態」＝在這一列**下面**展開一列，把 `GET /portfolios/:id/status` 畫進去；再按一次收起來。
 *
 * 為什麼是展開列而不是另一張卡片：狀態是「這個 portfolio 現在長什麼樣」，貼著它自己的那一列讀最省事；
 * 而且每個 portfolio 各自展開／收起，不用在同一個地方排隊。
 * 收起時直接把那一列移除：面板沒有任何計時器或背景工作，移除即結束（下次展開會重新抓一次狀態）。
 */
function toggleStatusRow(portfolio: api.Portfolio, row: HTMLTableRowElement, button: HTMLButtonElement): void {
  const key = String(portfolio.id);
  const open = openStatusRows.get(key);
  if (open !== undefined) {
    open.remove();
    openStatusRows.delete(key);
    button.textContent = '看狀態';
    return;
  }

  const statusRow = document.createElement('tr');
  statusRow.className = 'status-row';
  const td = document.createElement('td');
  td.colSpan = 6;
  const panel = document.createElement('div');
  panel.className = 'status-panel';
  td.appendChild(panel);
  statusRow.appendChild(td);
  row.after(statusRow);
  openStatusRows.set(key, statusRow);
  button.textContent = '收起狀態';

  mountStatusPanel({
    portfolioId: portfolio.id,
    container: panel,
    trace,
    baseUrl: () => effectiveBackendBaseUrl(readConfig()),
    token: () => session?.token ?? null,
  });
}

function renderPortfolios(): void {
  els.portfolioRows.replaceChildren();
  openStatusRows.clear();
  if (portfolios.length === 0) {
    const tr = document.createElement('tr');
    const td = cell('（空）後端回傳 0 筆 portfolio');
    td.colSpan = 6;
    td.className = 'linfo';
    tr.appendChild(td);
    els.portfolioRows.appendChild(tr);
    return;
  }
  for (const p of portfolios) {
    const tr = document.createElement('tr');
    const account = p.smartAccounts?.[0];
    tr.appendChild(cell(String(p.id), true));
    tr.appendChild(cell(`${String(p.strategyId)} / v${String(p.version)}`, true));
    tr.appendChild(cell(account ? `${shorten(account.address)} (chain ${account.chainId})` : '—', true));
    const gasReady = p.gas?.ready;
    tr.appendChild(cell(gasReady === true ? 'true' : gasReady === false ? 'false' : '—', true));
    tr.appendChild(cell(p.sessionKey ? String(p.sessionKey.expiresAt) : '—', true));
    const actions = document.createElement('td');
    const group = document.createElement('div');
    group.className = 'actions';
    const renew = document.createElement('button');
    renew.className = 'renew-btn';
    renew.textContent = '續期';
    renew.disabled = chainVerdict().blocked;
    renew.addEventListener('click', () => {
      void runRenewalFor(p, renew);
    });
    // 「看狀態」只是讀：不需要簽章、不受錢包鏈 gate 影響（狀態是後端算的，與本機錢包無關）。
    const view = document.createElement('button');
    view.className = 'ghost status-btn';
    view.textContent = '看狀態';
    view.title = `GET /portfolios/${String(p.id)}/status（漂移 / 持倉 / blocked / block）`;
    view.addEventListener('click', () => {
      toggleStatusRow(p, tr, view);
    });
    group.append(renew, view);
    actions.appendChild(group);
    tr.appendChild(actions);
    els.portfolioRows.appendChild(tr);
  }
}

els.loadPortfolios.addEventListener('click', async () => {
  if (session === null) return;
  els.loadPortfolios.disabled = true;
  trace.step('GET /portfolios');
  try {
    portfolios = await api.listPortfolios(effectiveBackendBaseUrl(readConfig()), session.token);
    trace.ok(`GET /portfolios → ${portfolios.length} 筆`);
    for (const p of portfolios) trace.raw(`portfolio #${String(p.id)}`, p);
    renderPortfolios();
  } catch (err) {
    trace.fail('GET /portfolios', err);
    els.portfolioRows.innerHTML = '';
    const tr = document.createElement('tr');
    const td = cell('載入失敗，原文見下方日誌');
    td.colSpan = 6;
    td.className = 'lfail';
    tr.appendChild(td);
    els.portfolioRows.appendChild(tr);
  } finally {
    els.loadPortfolios.disabled = false;
  }
});

// ---------------------------------------------------------------- renewal

async function runRenewalFor(portfolio: api.Portfolio, button: HTMLButtonElement): Promise<void> {
  if (!wallet || !session || chainVerdict().blocked) return;
  const cfg = readConfig();
  const base = effectiveBackendBaseUrl(cfg);
  const id = portfolio.id;

  button.dataset.busy = '1';
  button.disabled = true;
  const card = document.createElement('div');
  card.className = 'pf';
  const head = document.createElement('div');
  head.className = 'pf-head';
  const title = document.createElement('strong');
  title.textContent = `portfolio #${String(id)} · strategy ${String(portfolio.strategyId)}`;
  const badge = document.createElement('span');
  setBadge(badge, 'run', '進行中');
  head.append(title, badge);
  const out = document.createElement('pre');
  out.textContent = '—';
  card.append(head, out);
  els.renewalCards.appendChild(card);

  const write = (text: string): void => {
    out.textContent = text;
  };

  try {
    // a) renewal-params
    trace.step(`GET /portfolios/${String(id)}/renewal-params`);
    const params = await api.getRenewalParams(base, session.token, id);
    trace.ok('renewal-params', params);

    // b) 組 UserOp + 上鏈
    // bundler 只能由後端代送：alto v1.2.5 沒有 CORS，瀏覽器直連一定被 preflight 擋掉。
    // 所以這裡不再組 bundler URL —— params.bundlerUrl 只是資訊（已印在日誌裡）。
    const bundlerRelay = { baseUrl: base, path: cfg.bundlerRelayPath, token: session.token };
    trace.info(`bundler JSON-RPC 一律走後端 relay：POST ${bundlerRelay.baseUrl}${bundlerRelay.path}`);
    const outcome = await executeRenewal({
      params,
      wallet,
      rpcUrl: cfg.rpcUrl,
      bundlerRelay,
      expectedChainId: cfg.chainId,
      trace,
    });

    // c/d 已印在日誌；先寫入摘要。
    write(
      [
        `portfolio        ${String(params.portfolioId)}`,
        `chainId          ${outcome.chainId}`,
        `account          ${params.accountAddress}`,
        `owner            ${params.ownerAddress}`,
        `executor         ${params.executorAddress}`,
        `entryPoint       ${params.entryPoint}`,
        `sessionKeyAddress ${params.sessionKeyAddress}`,
        `permissionId     ${params.permissionId}`,
        `keyRef           ${params.keyRef}`,
        `validUntil       ${String(params.validUntil)}`,
        '',
        `nonce            ${outcome.nonce}`,
        `callData         ${outcome.callData}`,
        `gas.callGasLimit            ${outcome.gas.callGasLimit} (${BigInt(outcome.gas.callGasLimit)})`,
        `gas.verificationGasLimit    ${outcome.gas.verificationGasLimit} (${BigInt(outcome.gas.verificationGasLimit)})`,
        `gas.preVerificationGas      ${outcome.gas.preVerificationGas} (${BigInt(outcome.gas.preVerificationGas)})`,
        `maxFeePerGas                ${outcome.fees.maxFeePerGas} (${BigInt(outcome.fees.maxFeePerGas)})`,
        `maxPriorityFeePerGas        ${outcome.fees.maxPriorityFeePerGas} (${BigInt(outcome.fees.maxPriorityFeePerGas)})`,
        `gasUsed (actual) ${outcome.actualGasUsed ?? '—'}`,
        `gasCost (actual) ${outcome.actualGasCost ?? '—'}`,
        '',
        `userOpHash       ${outcome.userOpHash}`,
        `userOpHash 與本地計算一致？ ${outcome.userOpHashMatchesLocally ? 'yes' : 'NO（bundler 回的 hash 不同，要查）'}`,
        `transactionHash  ${outcome.txHash}`,
        `receipt.status   ${outcome.receiptStatus}`,
        `signature        ${outcome.signature}`,
        '',
        '（完整逐步日誌見頁面最下方）',
      ].join('\n'),
    );

    if (outcome.receiptStatus !== 'success') {
      throw new Error(`交易上鏈但 status=${outcome.receiptStatus}；不收斂成 "成功"，請看上面的日誌`);
    }

    // e) renewal-result
    trace.step(`POST /portfolios/${String(id)}/renewal-result`);
    const result = await api.postRenewalResult(base, session.token, id, {
      txHash: outcome.txHash,
      userOpHash: outcome.userOpHash,
      permissionId: params.permissionId,
      sessionKeyAddress: params.sessionKeyAddress,
      keyRef: params.keyRef,
      validUntil: params.validUntil,
      policySnapshot: params.policySnapshot,
    });
    trace.ok('renewal-result', result);
    out.textContent += `\n\na 到 e 全數完成\nrenewal-result: ${format(result)}`;
    setBadge(badge, 'ok', result.duplicate === true ? '成功（duplicate）' : '成功');
  } catch (err) {
    setBadge(badge, 'fail', '失敗');
    trace.fail(`portfolio #${String(id)} 續期`, err);
    out.textContent += `\n\n失敗（原文見下方日誌）:\n${errorText(err)}`;
  } finally {
    delete button.dataset.busy;
    // 收尾回到 gate 的判定：跑到一半鏈被切走，這裡就不該把按鈕打開。
    button.disabled = chainVerdict().blocked;
  }
}
