import {
  createWalletClient,
  custom,
  defineChain,
  type Address,
  type Chain,
  type Hex,
  type Account,
  type Transport,
  type WalletClient,
} from 'viem';
import { anvil, bsc } from 'viem/chains';

/**
 * 這裡完全沒有模式 B 的程式碼（也沒有 `viem/accounts` 的 import）：它搬到 `src/dev.ts`，
 * 由 `src/main.ts` 用 `import.meta.env.DEV` 動態載入，production build 時整段被 tree-shake 掉。
 */

/** 只宣告我們會用到的方法，避免把整包 EIP-1193 型別拉進來。 */
export type EthereumProvider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export type WalletMode = 'injected' | 'dev';

export type WalletConnection = {
  mode: WalletMode;
  address: Address;
  chain: Chain;
  /** EIP-6963 的 info.name（例如 MetaMask / Phantom）。走 window.ethereum 保底路徑時是 undefined。 */
  providerName?: string;
  /** true = 呼叫端沒指定 provider，這次是 window.ethereum 保底路徑；錢包身分未知。 */
  providerIsFallback?: boolean;
  /**
   * 連線時選定的那個 provider（EIP-6963 的結果）。
   * 之後的 eth_chainId / wallet_switchEthereumChain / chainChanged 一律只碰這一個 —— 不重讀
   * window.ethereum，否則多錢包環境會在「另一個錢包」上切鏈。模式 B（本地簽章）沒有 provider。
   */
  provider?: EthereumProvider;
  /**
   * ⚠ 一定要帶 account：ZeroDev SDK 靠 walletClient.account 判斷是否走 provider 分支。
   * 型別也把 account 釘成 Account，讓 signerToEcdsaValidator 能直接吃（Signer = LocalAccount | WalletClient with account）。
   */
  walletClient: WalletClient<Transport, Chain, Account>;
};

/** 呼叫端從 EIP-6963 清單挑好的 provider；name 來自 info.name，只用於 UI 顯示。 */
export type InjectedProviderChoice = { provider: EthereumProvider; name?: string };

/**
 * ⚠ 這只是 fallback，不是連線入口。
 *
 * `window.ethereum` 只會被「最後注入」的錢包佔用：裝了 Phantom + MetaMask 時，較晚注入的那個
 * 拿走這個槽位，用它就是隨機連到某個錢包（使用者實測：點模式 A 連到 Phantom 而不是 MetaMask）。
 * 正式路徑是 EIP-6963（`src/providers.ts` 的 `discoverProviders`）；這裡僅供「一個 6963 錢包
 * 都沒有廣播」的保底，UI 會把它標成「不確定是哪個錢包」。
 */
export function fallbackInjectedProvider(): EthereumProvider | undefined {
  return (globalThis as unknown as { ethereum?: EthereumProvider }).ethereum;
}

/**
 * chainId → viem Chain。56 用 bsc、31337（anvil fork 的預設）用 anvil，
 * 其他就動態組一個。之所以要「動態」：userOpHash 的 domain separator 含 chainId，
 * 拿錯 chainId 簽出來的簽章上鏈後必定 AA24 signature error。
 */
export function chainFor(chainId: number, rpcUrl: string): Chain {
  if (chainId === bsc.id) return bsc;
  if (chainId === anvil.id) return anvil;
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/**
 * 模式 A：瀏覽器注入錢包（真實路徑）。
 *
 * provider 由呼叫端明確給（來自 EIP-6963 清單），這個 function 不再自己去抓 `window.ethereum`。
 * 只有呼叫端完全不給 provider 時才退回 window.ethereum，並在 connection 上標記 providerIsFallback。
 */
export async function connectInjected(
  chain: Chain,
  choice?: InjectedProviderChoice,
): Promise<{ connection: WalletConnection; chainIdHex: string }> {
  const isFallback = choice === undefined;
  // fallback 判定：只有呼叫端沒指定 provider 時，才去碰 window.ethereum（見上面 fallbackInjectedProvider 的警告）。
  const provider = choice?.provider ?? fallbackInjectedProvider();
  if (!provider) {
    throw new Error('找不到注入錢包：EIP-6963 沒有任何錢包廣播，window.ethereum 也不存在');
  }

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  const address = accounts?.[0];
  if (!address) throw new Error('eth_requestAccounts 回傳空陣列：錢包沒有授權任何帳號');

  const chainIdHex = String(await provider.request({ method: 'eth_chainId' }));

  return {
    connection: {
      mode: 'injected',
      address,
      chain,
      providerName: isFallback ? undefined : choice?.name,
      providerIsFallback: isFallback,
      provider,
      // account 必須明寫，否則 SDK 會自己再 eth_requestAccounts 一次。
      walletClient: createWalletClient({ account: address, chain, transport: custom(provider) }) as unknown as WalletClient<
        Transport,
        Chain,
        Account
      >,
    },
    chainIdHex,
  };
}

// ---------------------------------------------------------------- chain（EIP-3326 / EIP-1193）

/** EIP-1193：使用者按下「拒絕」。切鏈被拒就是這個碼，原文照印，UI 標「已取消」。 */
export const USER_REJECTED_CODE = 4001;
/** EIP-3326：錢包不認識這條鏈。這時才該改用 wallet_addEthereumChain 加入。 */
export const UNRECOGNIZED_CHAIN_CODE = 4902;

const ERROR_SEARCH_KEYS = ['cause', 'data', 'originalError', 'error'] as const;
const MAX_ERROR_DEPTH = 6;

/**
 * 錯誤碼要往巢狀裡找：同一個 4902 可能出現在 `err.code`、`err.data.originalError.code`
 * 或 viem 包過的 `cause` 上，只讀最外層會漏掉 fallback 的機會。
 */
export function rpcErrorCode(err: unknown, depth = 0): number | undefined {
  if (depth > MAX_ERROR_DEPTH || err === null || typeof err !== 'object') return undefined;
  const node = err as Record<string, unknown>;
  if (typeof node.code === 'number') return node.code;
  for (const key of ERROR_SEARCH_KEYS) {
    const found = rpcErrorCode(node[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 讀「這個 provider」目前的 chainId（十進位）。
 *
 * 一定用連線時選定的 provider，不要用 window.ethereum：裝了多個錢包時後者可能是另一個錢包，
 * 讀到的鏈跟實際要簽的那個錢包不是同一件事。
 */
export async function readWalletChainId(provider: EthereumProvider): Promise<number> {
  const raw = String(await provider.request({ method: 'eth_chainId' }));
  const chainId = Number.parseInt(raw, 16);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`eth_chainId 回傳無法解析的值：${raw}`);
  return chainId;
}

/**
 * EIP-3326 切鏈。參數一律 hex（`wallet_switchEthereumChain` 只吃 hex，十進位只有畫面在用）。
 *
 * 錢包回 4902（不認識這條鏈）→ 用 `wallet_addEthereumChain` 把 config.rpcUrl 那條鏈加進去，
 * 然後**再切一次**（加入鏈不代表切過去）。
 */
export async function switchWalletChain(
  provider: EthereumProvider,
  chainId: number,
  rpcUrl: string,
  onStep?: (message: string) => void,
): Promise<{ addedChain: boolean }> {
  const hex = `0x${chainId.toString(16)}` as Hex;
  onStep?.(`wallet_switchEthereumChain({ chainId: '${hex}' })`);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    return { addedChain: false };
  } catch (err) {
    if (rpcErrorCode(err) !== UNRECOGNIZED_CHAIN_CODE) throw err;
    onStep?.(`錢包回 4902（不認識 ${hex}）→ wallet_addEthereumChain 加入 chainId=${String(chainId)}（RPC ${rpcUrl} / BNB / 18）`);
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hex,
          chainName: `chain-${String(chainId)}`,
          nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
          rpcUrls: [rpcUrl],
        },
      ],
    });
    onStep?.(`加入成功 → 再試一次 wallet_switchEthereumChain({ chainId: '${hex}' })`);
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    return { addedChain: true };
  }
}
