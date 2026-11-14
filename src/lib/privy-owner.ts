/**
 * Privy 登入的純邏輯（cre8-app#57）：誰是錢包主人、有哪些登入方式、錯誤要怎麼說。
 * 沒有 React、沒有 fetch、不 import Privy SDK —— 所以測得到。
 *
 * ## 錢包主人（owner）
 * 後端（backend#65）在使用者**第一次**拿 CRE8 session 時，把 Privy 帳號當下唯一的 EVM 錢包記成
 * 永久的主人：email／Google／Apple 註冊者是嵌入式錢包，錢包註冊者是那一個外部錢包。之後不論
 * 用哪種方式登入、又綁了什麼，session 都對應同一個主人。主人地址決定 smart account 地址。
 *
 * `/auth/privy` 的回應目前只有 `{ token, expiresAt }`，**沒有主人地址**。前端只能從 Privy 的
 * 帳號資料推回去，見 `resolveOwner`。
 */
import { ApiError } from './api';

/** Privy `user.linkedAccounts` 裡我們用得到的欄位（SDK 的型別更寬，這裡只取需要的）。 */
export type LinkedAccountLike = {
  type: string;
  address?: string | null;
  chainType?: string | null;
  walletClientType?: string | null;
  connectorType?: string | null;
  email?: string | null;
  /** Google／X 的顯示名稱。 */
  name?: string | null;
  /** X 的帳號（不含 @）。 */
  username?: string | null;
  /** X 的頭像網址（Privy 給的是 48px 的 `_normal`）。 */
  profilePictureUrl?: string | null;
  firstVerifiedAt?: Date | string | number | null;
};

export type EvmWallet = {
  /** Privy 給的原樣（通常是 checksum 格式）。比較時一律轉小寫。 */
  address: string;
  /** Privy 幫使用者建的嵌入式錢包（不是 MetaMask 那類外部錢包）。 */
  embedded: boolean;
  /** 綁定時間（毫秒）；讀不到為 null。 */
  linkedAt: number | null;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

export function isOwnerAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS.test(value) && !ZERO.test(value);
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function toMillis(value: LinkedAccountLike['firstVerifiedAt']): number | null {
  if (value === null || value === undefined) return null;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

/**
 * 帳號上的 EVM 錢包（去重、濾掉無效與零地址）。判斷條件與後端一致：
 * `type === 'wallet'` 且 `chainType === 'ethereum'`。
 */
export function evmWallets(accounts: readonly LinkedAccountLike[] | null | undefined): EvmWallet[] {
  const seen = new Set<string>();
  const wallets: EvmWallet[] = [];
  for (const account of accounts ?? []) {
    if (account.type !== 'wallet' || account.chainType !== 'ethereum' || !isOwnerAddress(account.address)) continue;
    const key = account.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    wallets.push({
      address: account.address,
      embedded: account.walletClientType === 'privy' || account.walletClientType === 'privy-v2' || account.connectorType === 'embedded',
      linkedAt: toMillis(account.firstVerifiedAt),
    });
  }
  return wallets;
}

export type OwnerResolution = {
  owner: string;
  /**
   * - `backend`     後端回應裡帶的（目前還沒有這個欄位；有了就以它為準）。
   * - `only-wallet` 帳號上只有一個 EVM 錢包，就是它。
   * - `remembered`  這台裝置先前確定過（見 `rememberOwner`）。
   * - `earliest`    有多個錢包、又沒有其他依據：取最早綁定的那一個。**這是推測**。
   */
  source: 'backend' | 'only-wallet' | 'remembered' | 'earliest';
};

/**
 * 這個 CRE8 session 的錢包主人是誰。回 `null` = 帳號上沒有任何 EVM 錢包，無從得知。
 *
 * 為什麼「最早綁定」通常是對的：首次登入前前端不開放綁其他錢包（後端也會回 409），所以主人
 * 一定是帳號上的第一個錢包，後來綁的時間都比它晚。不成立的情況：主人錢包後來被解除綁定
 * （這個 app 沒有提供解除綁定）。要完全確定，需要後端在回應裡帶主人地址。
 */
export function resolveOwner(input: {
  responseAddress?: unknown;
  accounts: readonly LinkedAccountLike[] | null | undefined;
  remembered?: string | null;
}): OwnerResolution | null {
  if (isOwnerAddress(input.responseAddress)) return { owner: input.responseAddress, source: 'backend' };
  const wallets = evmWallets(input.accounts);
  if (isOwnerAddress(input.remembered)) {
    // 用帳號上的寫法（大小寫）；主人已不在帳號上時仍以記下的為準，因為後端不會換主人。
    const linked = wallets.find((wallet) => sameAddress(wallet.address, input.remembered));
    return { owner: linked?.address ?? input.remembered, source: 'remembered' };
  }
  const [first] = wallets;
  if (first === undefined) return null;
  if (wallets.length === 1) return { owner: first.address, source: 'only-wallet' };
  // 穩定排序：時間相同或讀不到時維持 Privy 給的順序；讀不到時間的排最後。
  const earliest = [...wallets].sort((a, b) => (a.linkedAt ?? Infinity) - (b.linkedAt ?? Infinity))[0] ?? first;
  return { owner: earliest.address, source: 'earliest' };
}

const OWNER_KEY = 'cre8.privyOwner';

type OwnerStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** 這台裝置記下的主人（以 Privy 使用者 id 為鍵）。主人是永久的，所以放 localStorage。 */
export function readRememberedOwner(storage: OwnerStorage | null, userId: string): string | null {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(OWNER_KEY) ?? 'null');
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[userId] : null;
    return isOwnerAddress(value) ? value : null;
  } catch {
    return null;
  }
}

/** 這台裝置有沒有人用 Privy 登入過（只看有沒有記過主人，不看是誰）。 */
export function hasRememberedOwner(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(OWNER_KEY) ?? 'null');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

/** 只在確定時才記（`backend`、`only-wallet`）；推測出來的不記，免得把猜的變成「確定的」。 */
export function rememberOwner(storage: OwnerStorage | null, userId: string, resolution: OwnerResolution): void {
  if (resolution.source !== 'backend' && resolution.source !== 'only-wallet') return;
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(OWNER_KEY) ?? 'null');
    const map = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    storage?.setItem(OWNER_KEY, JSON.stringify({ ...map, [userId]: resolution.owner }));
  } catch {
    // storage 被擋就只是下次要重新推一次。
  }
}

/**
 * identity token 裡簽進去的 EVM 錢包（小寫）。讀不出來回 `null`。
 *
 * 只用來判斷「token 是不是已經帶到剛建好的嵌入式錢包」：嵌入式錢包是登入**之後**才建的，
 * 登入當下發的 token 還沒有它，直接送給後端一定是 409 `PRIVY_NO_WALLET`。
 * 這裡**不驗簽**，也不拿它做任何信任判斷 —— 驗證在後端。
 */
export function identityTokenWallets(token: string | null | undefined): string[] | null {
  if (typeof token !== 'string') return null;
  const segment = token.split('.')[1];
  if (segment === undefined || segment === '') return null;
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const raw = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).linked_accounts : null;
    const linked: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(linked)) return null;
    // token 裡的欄位是 snake_case（`chain_type`）。
    const accounts = linked
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => ({ type: String(entry.type), chainType: entry.chain_type as string, address: entry.address as string }));
    return evmWallets(accounts).map((wallet) => wallet.address.toLowerCase());
  } catch {
    return null;
  }
}

export type SignInMethodKind = 'email' | 'google' | 'apple' | 'x' | 'wallet';

export type SignInMethod = {
  kind: SignInMethodKind;
  /** 給使用者看的識別：email 地址，或縮短的錢包地址。 */
  detail: string;
};

const METHOD_NAME: Record<SignInMethodKind, string> = { email: 'Email', google: 'Google', apple: 'Apple', x: 'X', wallet: 'Wallet' };

export function signInMethodName(kind: SignInMethodKind): string {
  return METHOD_NAME[kind];
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * 帳號上已經綁的登入方式。嵌入式錢包不算：使用者不是「用它登入」的，它是登入後才有的。
 */
export function signInMethods(accounts: readonly LinkedAccountLike[] | null | undefined): SignInMethod[] {
  const methods: SignInMethod[] = [];
  for (const account of accounts ?? []) {
    if (account.type === 'email' && typeof account.address === 'string') methods.push({ kind: 'email', detail: account.address });
    if (account.type === 'google_oauth') methods.push({ kind: 'google', detail: account.email ?? '' });
    if (account.type === 'apple_oauth') methods.push({ kind: 'apple', detail: account.email ?? '' });
    if (account.type === 'twitter_oauth') methods.push({ kind: 'x', detail: account.username ? `@${account.username}` : account.name ?? '' });
  }
  for (const wallet of evmWallets(accounts)) {
    if (!wallet.embedded) methods.push({ kind: 'wallet', detail: short(wallet.address) });
  }
  return methods;
}

/** 對使用者來說是同一件事的三種登入方式：「我的信箱」。 */
const EMAIL_KINDS: readonly SignInMethodKind[] = ['google', 'email', 'apple'];

/**
 * 帳號上的信箱（Google、email 驗證碼、Apple 三者擇一顯示，優先順序照這個順序）。沒有回 null。
 *
 * 使用者回饋（2026-11-14）：「email 跟 google 不是一樣的嗎？」——技術上是三種登入方式，
 * 但畫面上只該有一列「Email」。
 */
export function emailIdentity(methods: readonly SignInMethod[]): SignInMethod | null {
  for (const kind of EMAIL_KINDS) {
    const found = methods.find((method) => method.kind === kind);
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * 還可以加綁哪些：**信箱（用 Google）與 X，各一個**。
 *
 * - 已經有信箱（不論是 Google、email 驗證碼還是 Apple）就不再問要不要綁另一種信箱。
 * - **不提供再綁錢包**：一個人只有一個錢包，就是註冊時決定的錢包主人（產品架構 P02）。
 *   再綁一個錢包只會讓人以為自己有兩個錢包，也會讓「誰是主人」變得不明確。
 */
export function linkableMethods(methods: readonly SignInMethod[]): SignInMethodKind[] {
  const linkable: SignInMethodKind[] = [];
  if (emailIdentity(methods) === null) linkable.push('google');
  if (!methods.some((method) => method.kind === 'x')) linkable.push('x');
  return linkable;
}

export type Profile = {
  /** 顯示名稱。沒有任何來源時是 null（畫面改顯示主人地址）。 */
  name: string | null;
  /** X 的 @帳號。 */
  handle: string | null;
  /** 頭像網址（目前只有 X 有）。 */
  avatarUrl: string | null;
};

/**
 * 用戶頁上方的名字與頭像，全部取自已綁的帳號（cre8-app 用戶頁）。後端沒有用戶資料，這些只有本人看得到。
 *
 * 優先順序：X（有名字、@帳號、頭像）→ Google 的名字 → email 的 @ 前面那段 → 沒有。
 */
export function profileOf(accounts: readonly LinkedAccountLike[] | null | undefined): Profile {
  const list = accounts ?? [];
  const x = list.find((account) => account.type === 'twitter_oauth');
  const google = list.find((account) => account.type === 'google_oauth');
  const apple = list.find((account) => account.type === 'apple_oauth');
  const email = list.find((account) => account.type === 'email');
  const clean = (value: string | null | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const localPart = (value: string | null | undefined) => clean(value?.split('@')[0]);
  const handle = clean(x?.username);
  const name = clean(x?.name) ?? clean(google?.name) ?? (handle === null ? null : handle)
    ?? localPart(email?.address) ?? localPart(google?.email) ?? localPart(apple?.email);
  // X 給的是 48px 的縮圖；換成 400px 的同一張（X 的網址規則：`_normal` → `_400x400`）。
  const picture = clean(x?.profilePictureUrl);
  const avatarUrl = picture === null || !/^https:\/\//.test(picture) ? null : picture.replace(/_normal(\.[a-z]+)$/i, '_400x400$1');
  return { name, handle, avatarUrl };
}

/**
 * 前端自己發現的設定問題（不是後端回的）。
 * - `NO_WALLET`          等不到嵌入式錢包建好。
 * - `NO_IDENTITY_TOKEN`  Privy 沒有給 identity token（Dashboard 沒有打開 identity tokens）。
 */
export class PrivySetupError extends Error {
  readonly code: 'NO_WALLET' | 'NO_IDENTITY_TOKEN';
  constructor(code: 'NO_WALLET' | 'NO_IDENTITY_TOKEN') {
    super(code);
    this.name = 'PrivySetupError';
    this.code = code;
  }
}

export type PrivyLoginFailure = {
  /** 白話英文。 */
  message: string;
  /** `retry` = 再試一次有機會成功；`sign-in-again` = 要重新登入；`none` = 使用者自己解決不了。 */
  action: 'retry' | 'sign-in-again' | 'none';
  /** 可展開的原始資訊（狀態碼、代碼、後端訊息）。 */
  technical: string;
};

/** 換 CRE8 session 失敗時要說什麼。對應 backend#65 的 401／409／503 與前端自己的兩種情況。 */
export function explainPrivyLoginFailure(error: unknown): PrivyLoginFailure {
  if (error instanceof PrivySetupError) {
    return error.code === 'NO_WALLET'
      ? { message: 'Your wallet is still being set up. Try again in a moment.', action: 'retry', technical: error.code }
      : {
          message: 'Sign-in could not be completed because the sign-in service did not return your identity. Please try again later.',
          action: 'retry',
          technical: `${error.code}: Privy returned no identity token (enable identity tokens in the Privy dashboard)`,
        };
  }
  if (error instanceof ApiError) {
    const technical = `${error.status === 0 ? 'NETWORK' : `${error.status} · ${error.code}`}\n${error.message}`;
    if (error.code === 'PRIVY_NO_WALLET') {
      return { message: 'Your wallet is still being set up. Try again in a moment.', action: 'retry', technical };
    }
    if (error.code === 'PRIVY_OWNER_AMBIGUOUS') {
      return {
        message:
          'This sign-in has more than one wallet attached, so CRE8 cannot tell which one should own your account. Nothing was created. Please contact support.',
        action: 'none',
        technical,
      };
    }
    if (error.status === 401) {
      return { message: 'Your sign-in has expired. Please sign in again.', action: 'sign-in-again', technical };
    }
    if (error.status === 429) {
      return { message: 'Too many sign-in attempts. Wait a minute, then try again.', action: 'retry', technical };
    }
    if (error.status === 503 || error.code === 'PRIVY_UNAVAILABLE') {
      return { message: 'Email and social sign-in is not available right now. Please try again later.', action: 'retry', technical };
    }
    if (error.status === 0) {
      return { message: 'CRE8 could not be reached. Check your connection, then try again.', action: 'retry', technical };
    }
    return { message: 'Sign-in could not be completed. Please try again.', action: 'retry', technical };
  }
  const technical = error instanceof Error ? error.message : String(error);
  return { message: 'Sign-in could not be completed. Please try again.', action: 'retry', technical };
}

/**
 * 沒有可簽名的主人錢包時要說什麼（只能看）。`null` = 可以簽，或還在確認中。
 *
 * - 主人是外部錢包、目前沒有連著（錢包註冊者用 Google 等登入）：請他連原本的錢包。
 * - 主人是嵌入式錢包卻不在這台裝置上：不是「連錢包」能解決的，請他重新登入。
 */
export function readOnlyNotice(input: { owner: string | null; ownerEmbedded: boolean; signer: 'checking' | 'ready' | 'missing' }): string | null {
  if (input.owner === null || input.signer !== 'missing') return null;
  return input.ownerEmbedded
    ? 'Your CRE8 wallet is not available in this browser yet, so you can view your account but not trade. Sign out and sign in again.'
    : `You can view this account, but buying, selling and withdrawing need its owner wallet ${short(input.owner)}. Connect that wallet to continue.`;
}
