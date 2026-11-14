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
  /** 前端自己知道的合約地址（只有測試網有地址簿）。主網與本機 fork 一律由後端回報。 */
  contracts: ChainContracts | null;
};

const isHttpUrl = (value: string | undefined): value is string => value !== undefined && /^https?:\/\//.test(value);

export function chainProfile(chainId: number, rpcOverride?: string): ChainProfile {
  if (chainId === 56) {
    return {
      id: 56,
      name: 'BNB Smart Chain',
      testnet: false,
      nativeSymbol: 'BNB',
      rpcUrl: isHttpUrl(rpcOverride) ? rpcOverride : 'https://bsc-dataseed.binance.org',
      explorerUrl: 'https://bscscan.com',
      sponsored: false,
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
      rpcUrl: isHttpUrl(rpcOverride) ? rpcOverride : 'https://bsc-testnet.publicnode.com',
      explorerUrl: 'https://testnet.bscscan.com',
      sponsored: true,
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
  constructor(kind: keyof ChainContracts, reported: string, expected: string) {
    super(
      `The server reported a ${kind} contract (${reported}) that is not the one deployed for this network (${expected}). ` +
        'Nothing was sent. Please try again later.',
    );
    this.name = 'AddressBookMismatch';
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
