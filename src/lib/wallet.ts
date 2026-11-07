/**
 * 錢包連線（EIP-6963）與訊息簽名。
 *
 * 為什麼用 EIP-6963 而不是 `window.ethereum`：後者是「最後注入者贏」，裝了多個錢包時會連到
 * 不是使用者想連的那一個。6963 讓每個錢包自己廣播身分，dApp 列出清單讓使用者選。
 */
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

export type ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type ProviderDetail = {
  info: ProviderInfo;
  provider: Eip1193Provider;
};

/** rdns → 已廣播的錢包。同一個錢包重複廣播時以最後一次為準。 */
const announced = new Map<string, ProviderDetail>();
let listening = false;

function isProviderDetail(value: unknown): value is ProviderDetail {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { info?: { rdns?: unknown; uuid?: unknown }; provider?: { request?: unknown } };
  return (
    typeof candidate.info?.rdns === 'string' &&
    typeof candidate.info?.uuid === 'string' &&
    typeof candidate.provider?.request === 'function'
  );
}

function ensureListener(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('eip6963:announceProvider', (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isProviderDetail(detail)) announced.set(detail.info.rdns, detail);
  });
}

/**
 * 列出可用的錢包。
 *
 * 先 dispatch `eip6963:requestProvider`（錢包收到會補廣播，所以「比 dApp 早載入」的錢包也抓得到），
 * 等一小段時間讓晚一步注入的錢包趕上。
 */
export function discoverProviders(waitMs = 300): Promise<ProviderDetail[]> {
  if (typeof window === 'undefined') return Promise.resolve([]);
  ensureListener();
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  return new Promise((resolve) => {
    window.setTimeout(() => resolve([...announced.values()]), waitMs);
  });
}

/** 已在清單裡的錢包（不重新等待），給「重新整理」按鈕用。 */
export function knownProviders(): ProviderDetail[] {
  return [...announced.values()];
}

export async function connectProvider(provider: Eip1193Provider): Promise<string> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== 'string') throw new Error('錢包沒有回傳帳號（使用者可能取消了連線）');
  return first;
}

export async function chainIdOf(provider: Eip1193Provider): Promise<number> {
  const raw = await provider.request({ method: 'eth_chainId' });
  if (typeof raw !== 'string') throw new Error('eth_chainId 回傳了非字串');
  return Number.parseInt(raw, 16);
}

/** 用錢包簽 EIP-191 訊息（SIWE 就是 personal_sign）。 */
export async function signWithProvider(
  provider: Eip1193Provider,
  address: string,
  message: string,
): Promise<string> {
  const signature = await provider.request({
    method: 'personal_sign',
    params: [toHexMessage(message), address],
  });
  if (typeof signature !== 'string') throw new Error('錢包沒有回傳簽名');
  return signature;
}

function toHexMessage(message: string): Hex {
  const bytes = new TextEncoder().encode(message);
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex as Hex;
}

export type DevSigner = {
  address: string;
  signMessage: (message: string) => Promise<string>;
};

/**
 * dev 用：極簡私鑰簽名。**只在 `import.meta.env.DEV` 下提供入口**，且私鑰只存在記憶體。
 *
 * 這不是「另一個登入方式」，是讓本機 anvil 的測試帳戶能走完同一條 SIWE 流程 —— 沒有它，
 * 每次改前端都得插硬體錢包。
 */
export function createDevSigner(privateKey: Hex): DevSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signMessage: (message: string) => account.signMessage({ message }),
  };
}

export function isLikelyPrivateKey(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}
