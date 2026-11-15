/**
 * 這個 app 跑在哪一條鏈上，以及那條鏈的設定（cre8-app#62）。純函式：不讀 env、不碰 React。
 *
 * 三種情況，由 `VITE_CHAIN_ID` 決定（讀取在 `lib/kernel.ts` 的 `CHAIN`）：
 *   - 56  ：BSC 主網。
 *   - 97  ：BSC 測試網。合約地址來自地址簿（`lib/testnet-97.ts`），gas 由平台代付。
 *   - 其他：本機 fork（1337 等）。
 *
 * **各自獨立，不互相回落**：測試網的 RPC、區塊瀏覽器、合約地址一律是測試網自己的，
 * 任何欄位缺了都不會改拿主網的值來用。
 */
import { TESTNET_97 } from './testnet-97';

export type ChainContracts = {
  registry: string;
  executor: string;
  usdt: string;
  paymaster: string;
  entryPoint: string;
};

export type ChainProfile = {
  id: number;
  name: string;
  /** true = 測試網：畫面要明講代幣沒有價值。 */
  testnet: boolean;
  /** 原生代幣（付 gas 的）在畫面上怎麼稱呼。 */
  nativeSymbol: string;
  rpcUrl: string;
  /** 區塊瀏覽器；本機 fork 沒有。 */
  explorerUrl: string | null;
  /** true = 帳戶的 UserOp 由平台代付 gas（後端 `/paymaster/sponsor`），帳戶裡不需要原生代幣。 */
  sponsored: boolean;
  /**
   * true = 買入的錢由水龍頭直接打進基金帳戶（測試網），不從使用者的錢包轉。
   * 那一筆轉帳是一般交易、要原生代幣付 gas，而 email 登入的人錢包裡沒有。
   */
  faucetFunded: boolean;
  /** 前端自己知道的合約地址（只有測試網有地址簿）。主網與本機 fork 一律由後端回報。 */
  contracts: ChainContracts | null;
};

const isHttpUrl = (value: string | undefined): value is string => value !== undefined && /^https?:\/\//.test(value);

/** 沒設 `VITE_CHAIN_ID` 時的預設：本機 fork（見 `lib/kernel.ts` 的說明）。 */
export const DEFAULT_CHAIN_ID = 1337;

/**
 * 讀 `VITE_CHAIN_ID`。沒設、空字串（照 `.env.example` 複製後留下的 `VITE_CHAIN_ID=`）、不是正整數：一律用 1337。
 * `Number('')` 是 0，以前會變成一條叫 0 的鏈。
 */
export function readChainId(value: string | undefined): number {
  const trimmed = value?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return DEFAULT_CHAIN_ID;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) && id > 0 ? id : DEFAULT_CHAIN_ID;
}

/** 公開的 BSC 主網節點（認得出來就不拿來當測試網的 RPC）。 */
const MAINNET_RPC = /bsc-dataseed\.binance|bsc-dataseed\d*\.(binance|defibit|ninicoin)|bsc-rpc\.publicnode|bsc\.publicnode|bsc-mainnet|binance\.llamarpc|bsc\.drpc|56\.rpc/i;

/**
 * 測試網的 RPC：只收 `VITE_TESTNET_RPC_URL`（或明顯不是主網節點的 `VITE_RPC_URL`），否則用公開的測試網節點。
 * 部署只把 `VITE_CHAIN_ID` 改成 97、卻留著 production 的主網 `VITE_RPC_URL` 時，不能讀主網（cre8-app#93）。
 * 實際連到哪條鏈另由 `verifyRpcChain` 在交易前驗。
 */
export function testnetRpcUrl(testnetOverride?: string, generalOverride?: string): string {
  if (isHttpUrl(testnetOverride)) return testnetOverride;
  if (isHttpUrl(generalOverride) && !MAINNET_RPC.test(generalOverride)) return generalOverride;
  return 'https://bsc-testnet.publicnode.com';
}

export function chainProfile(chainId: number, rpcOverride?: string, testnetRpcOverride?: string): ChainProfile {
  if (chainId === 56) {
    return {
      id: 56,
      name: 'BNB Smart Chain',
      testnet: false,
      nativeSymbol: 'BNB',
      rpcUrl: isHttpUrl(rpcOverride) ? rpcOverride : 'https://bsc-dataseed.binance.org',
      explorerUrl: 'https://bscscan.com',
      sponsored: false,
      faucetFunded: false,
      contracts: null,
    };
  }
  if (chainId === TESTNET_97.chainId) {
    const { registry, executor, usdt, paymaster, entryPoint } = TESTNET_97.contracts;
    return {
      id: 97,
      name: 'BNB Smart Chain Testnet',
      testnet: true,
      nativeSymbol: 'tBNB',
      // 與合約部署手冊用的同一個公開節點（data-seed 節點只留幾分鐘的 state）。
      rpcUrl: testnetRpcUrl(testnetRpcOverride, rpcOverride),
      explorerUrl: 'https://testnet.bscscan.com',
      sponsored: true,
      faucetFunded: true,
      contracts: { registry, executor, usdt, paymaster, entryPoint },
    };
  }
  return {
    id: chainId,
    name: `CRE8 Local (${chainId})`,
    testnet: false,
    nativeSymbol: 'BNB',
    rpcUrl: isHttpUrl(rpcOverride) ? rpcOverride : 'http://127.0.0.1:8545',
    explorerUrl: null,
    sponsored: false,
    faucetFunded: false,
    contracts: null,
  };
}

/** `wallet_addEthereumChain` 的參數：錢包不認識這條鏈時用來把它加進去。 */
export function walletChainParams(profile: ChainProfile): {
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls?: string[];
} {
  return {
    chainName: profile.name,
    rpcUrls: [profile.rpcUrl],
    nativeCurrency: { name: profile.nativeSymbol, symbol: profile.nativeSymbol, decimals: 18 },
    ...(profile.explorerUrl === null ? {} : { blockExplorerUrls: [profile.explorerUrl] }),
  };
}

/** 後端回報的地址與地址簿不一致。前端停下，不拿這個地址去組交易。 */
export class AddressBookMismatch extends Error {
  /** 給 `ErrorNote` 用：標題與可展開的細節（兩個地址放細節，主要訊息只講發生什麼）。 */
  readonly title = 'Network setup problem';
  readonly technical: string;
  constructor(kind: keyof ChainContracts, reported: string, expected: string) {
    super('CRE8’s servers are pointing at the wrong contract for this network, so nothing was sent. This is on our side. Please try again later.');
    this.name = 'AddressBookMismatch';
    this.technical = `${kind}: server reported ${reported}, address book has ${expected}`;
  }
}

/**
 * 有地址簿的鏈（測試網）：後端回報的合約地址必須等於地址簿上的那一個，否則丟 `AddressBookMismatch`。
 * 沒有地址簿的鏈（主網、本機 fork）：原樣放行，行為與以前相同。
 *
 * 用在「前端要拿這個地址去組交易」的地方（對 executor 的 approve、對 registry 的 enroll）：
 * 後端設定錯（例如測試網環境指到主網的 executor）時，使用者不會對一個錯的合約授權。
 */
export function checkedContract(profile: ChainProfile, kind: keyof ChainContracts, reported: string): string {
  const expected = profile.contracts?.[kind];
  if (expected !== undefined && expected.toLowerCase() !== reported.toLowerCase()) {
    throw new AddressBookMismatch(kind, reported, expected);
  }
  return reported;
}

/** 錢包現在所在的鏈是不是 app 的鏈。`null`（讀不到）當成「不知道」，不算錯。 */
export function isWrongNetwork(profile: ChainProfile, walletChainId: number | null): boolean {
  return walletChainId !== null && walletChainId !== profile.id;
}

/** RPC 實際的鏈與 app 的鏈對不上：停用所有交易。 */
export class RpcChainMismatch extends Error {
  readonly title = 'Network setup problem';
  readonly technical: string;
  constructor(expected: number, actual: number | null, url: string) {
    super('This site is connected to the wrong network, so nothing can be sent. This is on our side. Please try again later.');
    this.name = 'RpcChainMismatch';
    this.technical = `RPC ${url} reported chain ${actual ?? 'unknown'}; this build expects chain ${expected}`;
  }
}

/**
 * 用一個獨立的 HTTP 請求問 RPC 的 `eth_chainId`（不經 Privy／錢包的 provider：那邊回的是它自己的設定，抓不出錯配）。
 * 回傳實際的鏈 id；讀不到回 null。
 */
export async function readRpcChainId(url: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    const body = (await response.json()) as { result?: unknown };
    return typeof body.result === 'string' && /^0x[0-9a-f]+$/i.test(body.result) ? Number(BigInt(body.result)) : null;
  } catch {
    return null;
  }
}

/**
 * 交易前的檢查：主網與測試網的 RPC 必須回報同一條鏈，否則丟 `RpcChainMismatch`。讀不到（null）也停，
 * 不在不知道連到哪條鏈的情況下送交易。本機 fork 不檢查（dev 的 /rpc proxy 不一定是 http URL）。
 */
export async function verifyRpcChain(profile: ChainProfile, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (profile.id !== 56 && profile.id !== 97) return;
  const actual = await readRpcChainId(profile.rpcUrl, fetchImpl);
  if (actual !== profile.id) throw new RpcChainMismatch(profile.id, actual, profile.rpcUrl);
}
