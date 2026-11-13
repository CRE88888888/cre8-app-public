import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { encodeFunctionData, formatEther, formatUnits, parseEther, parseUnits } from 'viem';
import type { Address } from 'viem';
import { closePosition, continueRedeem, enrollPortfolio, getAssets, getPortfolioStatus, getPortfolios, getRenewalParams, getStrategy, listStrategies, postRebalance, postRenewalResult, redeemPortfolio } from '../../lib/api';
import { CHAIN_ID, approveCalldata, bsc as appChain, publicClientFor, readOnlyClient, sendGasTopUp, sendRenewalUserOp, sendSudoCalls, sendSweep, sendWithdraw } from '../../lib/kernel';
import type { PortfolioStatus, RedeemResult } from '../../lib/api';
import { MOCK_FUNDS } from '../../data/mock-funds';
import {safePublicReturn} from '../../lib/public-navigation';
import {useMobile} from '../../lib/use-mobile';
import { AppBottomSheet, AppSheetClose } from '../../components/AppBottomSheet';
import { FundSnapshot } from './FundSnapshot';
import { TicketFund, TicketReceipt, TicketReview } from './TicketReview';
import type { TicketAction, TicketProgress } from './TicketReview';
import {catalogueTargets} from '../../data/public-fund-adapter';
import { REFERENCE_METADATA, referenceFund } from '../../lib/public-funds';
import { symbolOf, synthesizeCommunityFund } from '../../lib/community-fund';
import {periodMetrics} from '../../reference/lib/fund-explore';
import {FundOverview} from '../reference/FundOverview';
import { shortAddress, withdrawAmountWei } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import { useOwnerWallet } from '../../lib/use-owner-wallet';
import { useConnectedSessionToken } from '../../lib/use-connected-session';
import { WalletMenu } from '../../components/WalletMenu';
import { WHITELIST_COPY } from '../../lib/live-funds';
import { hasSellablePositions, lowerOf, sweepNativeWei } from '../../lib/close-position';
import { isPermissionFailure, renewedMessage, tradingPermissionHealth } from '../../lib/trading-permission';
import { buyAllowanceState, buyLimitMessage, checkEnrollment, describePause, explainA10Failure, pauseSourcesFromFlags, sameAllocation, PLATFORM_PAUSED_MESSAGE } from '../../lib/a10';
import { MAX_SELL_BATCHES, SellBatchError, SellUnfinished, afterSellRun, formatRemainingUsd, runSellBatches } from '../../lib/sell-batches';
import { cashUsdOf, sellTargetUsd, totalUsdOf, withdrawShortfallNote } from '../../lib/withdraw-plan';
import { AccountControls } from './AccountControls';
import { accountOnchainKey, loadAccountOnchain, useAccountOnchain } from './use-account-onchain';
import { useWallet } from '../../store/wallet';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge, ErrorNote, Note, Spinner } from '../../components/ui';
import { AssetLogo } from '../../components/AssetLogo';
import { toast, type ToastId } from '../../components/Toast';
import { TradeRoutes } from '../../components/TradeRoutes';
import type { RoutedStep } from '../../lib/venues';

/** 賣出／清倉因為交易權限失效而失敗時，接在錯誤後面的那句話。 */
const PERMISSION_HINT =
  'The fund could not sell because its trading permission is no longer accepted. Open My position and choose Renew permission, then try again.';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

/** 美元顯示（提領說明用；`$12.34`）。 */
function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(bps: number, digits = 2): string {
  const sign = bps < 0 ? '−' : '';
  return `${sign}${(Math.abs(bps) / 100).toFixed(digits)}%`;
}

/**
 * 基金頁 —— 對齊參考站 `app.cre8.finance/vault/<slug>` 的版面。
 *
 * 版面不是自己發明的：沿用設計稿的 `.vgrid / .vhead / .keyfig / .vault-performance /
 * .vault-where / .ticket / .pros-drawer`（樣式已在 `styles/vendor/design.css`）。
 * 左欄是「這檔基金是什麼、錢在哪」，右欄 `aside.side` 是**下單用的 ticket**。
 *
 * 兩種身份放在同一頁：
 *   1. 目錄頁：範例基金的 thesis / 走勢 / 配置（純前端資料）
 *   2. 真實策略：用名稱比對接到鏈上策略（Elon Universe → strategy 529），顯示即時配置，
 *      並讓使用者把 USDT 轉進**自己的** Kernel 帳戶（存款＝ERC-20 transfer，不需要 approve）
 */
export function FundPage(): ReactNode {
  // 換到另一支基金時整個重新掛載（cre8-app#18 次要問題）。
  // `/funds/strategy/1` 與 `/funds/strategy/2` 是同一個元件，React 會沿用 state：
  // 輸入框的金額、上一筆的「Withdrawn. tx …」與「Sent $… of …」都會留在下一支基金的畫面上。
  // 這一頁的 state 有二十幾個，逐一重置一定會漏；用 key 讓每支基金有自己的一份最不會錯。
  const { slug, id } = useParams<{ slug: string; id: string }>();
  return <FundPageBody key={id === undefined ? `slug:${slug ?? ''}` : `strategy:${id}`} />;
}

function FundPageBody(): ReactNode {
  useBodyClass('vault-page', 'fund-detail-redesign', 'atp-formal-fund', 'atp-complete-fund');
  const { slug, id: strategyIdParam } = useParams<{ slug: string; id: string }>();
  const strategyId = strategyIdParam === undefined ? null : Number(strategyIdParam);
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    const resetScroll = () => window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    resetScroll();
    // History traversal can restore scroll just after the route commits.
    const frame = window.requestAnimationFrame(resetScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  const token = useConnectedSessionToken();
  const wallet = useOwnerWallet();
  const queryClient = useQueryClient();

  let fund = MOCK_FUNDS.find((entry) => entry.slug === slug);
  let reference = referenceFund(slug ?? '');
  /**
   * id 模式（`/funds/strategy/:id`）：Community 策略沒有參考目錄的 slug，
   * 所以 `fund` / `reference` 都得現場合成 —— 但版面與下單流程完全同一套。
   */
  const communityStrategy = useQuery({
    queryKey: ['strategy', 'public', strategyId],
    queryFn: () => getStrategy('', strategyId as number),
    enabled: strategyId !== null && Number.isInteger(strategyId) && strategyId > 0,
  });
  const modelFees = reference?.fees;
  const modelPerformanceFee = modelFees
    ? Number((modelFees.perf + modelFees.platform).toFixed(2))
    : null;

  const strategies = useQuery({
    queryKey: ['strategies', token],
    queryFn: () => listStrategies(token as string),
    enabled: token !== null,
  });
  const assets = useQuery({
    queryKey: ['assets', token],
    queryFn: () => getAssets(token as string),
    enabled: token !== null,
    staleTime: 60_000,
  });
  const portfolios = useQuery({
    queryKey: queryKeys.portfolios(token),
    queryFn: () => getPortfolios(token as string),
    enabled: token !== null,
  });

  /**
   * id 模式（`/funds/strategy/:id`）的合成 fund：Community 策略沒有參考目錄的 slug，
   * 用 `synthesizeCommunityFund` 現場合成一個 ReferenceFund，餵給 FundOverview。
   *
   * 與 `/vaults` 的 Community 區塊共用同一個合成器，所以「列表看到的報酬」與「詳情頁看到的報酬」
   * 是同一組確定性數字（seed = id）。
   */
  const communityFund = useMemo(() => {
    const detail = communityStrategy.data;
    if (detail === undefined) return undefined;
    const version = detail.versions[0];
    const allocation = version?.allocation?.assets ?? [];
    const symbols = allocation.map((asset) => symbolOf(asset.address));
    const positions = allocation.map((asset, i) => ({
      p: symbols[i] ?? 'USDT',
      loc: symbols[i] ?? 'USDT',
      w: asset.weightBps / 100,
    }));
    return synthesizeCommunityFund({
      id: detail.id,
      name: detail.name,
      provider: detail.provider,
      onchainId: detail.onchainId,
      description: detail.description,
      createdAt: detail.createdAt,
      positions,
      seed: detail.id,
    });
  }, [communityStrategy.data]);

  // id 模式（`/funds/strategy/:id`）：用合成值覆寫 slug 模式的 fund / reference，
  // 讓後續的 FundOverview、ticket、facts 抽屜**完全走同一套程式碼**。
  if (strategyId !== null && communityFund !== undefined) {
    reference = communityFund;
    const detail = communityStrategy.data!;
    const version = detail.versions[0];
    fund = {
      slug: communityFund.slug,
      name: communityFund.name,
      symbol: 'CRE8',
      thesis: communityFund.strategy,
      subtitle: communityFund.strategy,
      kind: 'Community',
      mark: communityFund.name.replace(/[^A-Za-z\u4e00-\u9fff]/g, '').slice(0, 2).toUpperCase() || 'C8',
      risk: communityFund.risk,
      rebalance: 'drift',
      holdings: (version?.allocation?.assets ?? []).map((asset) => ({
        symbol: symbolOf(asset.address),
        weightBps: asset.weightBps,
      })),
    };
  }

  const strategy = useMemo(() => {
    // id 模式：策略就是這個 id 的那一檔（不再靠名稱對應 —— 名稱對應正是「Elon 同名」的根源）。
    if (strategyId !== null && communityStrategy.data !== undefined) {
      // StrategyDetail 是 StrategySummary 的超集，多出來的 versions 用不到，
      // 這裡直接以 StrategySummary 的形狀回傳（欄位都齊）。
      return {
        id: communityStrategy.data.id,
        provider: communityStrategy.data.provider,
        name: communityStrategy.data.name,
        description: communityStrategy.data.description,
        isPublic: communityStrategy.data.isPublic,
        swapFeeBps: communityStrategy.data.swapFeeBps,
        createdAt: communityStrategy.data.createdAt,
        onchainId: communityStrategy.data.onchainId,
      };
    }
    return fund === undefined ? undefined : (strategies.data?.items ?? []).find((item) => item.name === fund.name);
  }, [fund, strategies.data, strategyId, communityStrategy.data]);
  const holding = (portfolios.data ?? []).find((portfolio) => portfolio.strategyId === strategy?.id);

  const usdt = (assets.data ?? []).find((asset) => asset.isNumeraire);

  const status = useQuery({
    queryKey: ['fund-status', token, holding?.id],
    queryFn: () => getPortfolioStatus(token as string, holding?.id as number),
    enabled: token !== null && holding !== undefined,
    staleTime: 15_000,
    retry: 0,
  });



  // `?tab=withdraw` 直接開提領分頁 —— 分頁狀態本來只在記憶體裡，沒有網址就只能靠手動點。
  const [search,setSearch] = useSearchParams();
  const mobile=useMobile();
  const ticketToast = useRef<ToastId | null>(null);
  const [mobileTicket,setMobileTicket]=useState(search.get('ticket')==='1'||search.get('tab')==='withdraw');
  function dismissTicketToast() {
    if (ticketToast.current === null) return;
    toast.dismiss(ticketToast.current);
    ticketToast.current = null;
  }

  const setTicketOpen = (open: boolean) => {
    setMobileTicket(open);
    const next = new URLSearchParams(window.location.search);
    if (open) next.set('ticket', '1');
    else {
      dismissTicketToast();
      next.delete('ticket');
      next.delete('tab');
    }
    setSearch(next, { replace: true });
  };
  // 返回目錄只接受本站路徑，保留篩選但不讓外部網址成為導向目標。
  const requestedReturn = search.get('returnTo');
  const backTo = safePublicReturn(requestedReturn);
  const [tab, setTab] = useState<'deposit' | 'withdraw'>(search.get('tab') === 'withdraw' ? 'withdraw' : 'deposit');
  // 切到 Sell 分頁時，手上的 status 如果不是剛讀的就重讀一次（cre8-app#49）。
  // 排程器會在背景買賣，頁面不會自己知道；而 Sell 面板的 Cash／positions／total 是使用者決定賣多少的依據。
  // 只在「切到 Sell」那一刻檢查（不跟著每次資料更新重跑）；送出前另外還會再讀一次，那才是判斷要不要賣的依據。
  const statusUpdatedAt = status.dataUpdatedAt;
  const holdingId = holding?.id;
  useEffect(() => {
    if (tab !== 'withdraw' || holdingId === undefined || token === null) return;
    if (statusUpdatedAt === 0 || Date.now() - statusUpdatedAt < 5_000) return;
    void queryClient.invalidateQueries({ queryKey: ['fund-status', token, holdingId] });
  }, [tab, holdingId, token]);
  // 金額**不預填**：任何預設值都是猜的（使用者的餘額、他想存多少，我們都不知道），
  // 而預填超過餘額的數字會讓他一進頁面就看到紅字警告。留空，讓他自己輸入或按 Max。
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // `?facts=1` / `?position=1` 直接開抽屜：客服貼連結給使用者、或營運要截圖核對時用得到。
  const [facts, setFacts] = useState(search.get('facts') === '1');
  const factsTrigger = useRef<HTMLButtonElement>(null);
  // 「My position」＝這個投組的即時狀態（原本在 /portfolios/:id 才能看，現在收進基金頁）。
  const [myPosition, setMyPosition] = useState(search.get('position') === '1');
  const [toppingUp, setToppingUp] = useState(false);
  /** 還沒授權給 executor 的資產（`null` = 還沒讀完）。有錢但沒授權時，UI 必須說出來。 */
  const [unapproved, setUnapproved] = useState<string[] | null>(null);
  const [approving, setApproving] = useState(false);
  /** 續期交易權限（session key）：進行中的旗標，與成功後要留在畫面上的那句話。 */
  const [renewing, setRenewing] = useState(false);
  const [renewNote, setRenewNote] = useState<string | null>(null);
  // 提領：預設 USDT（現金腿），可選帳戶裡任何有餘額的資產 —— 每個都只是一筆 transfer。
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawError, setWithdrawError] = useState<unknown>(null);
  const [withdrawTx, setWithdrawTx] = useState<string | null>(null);
  const [withdrawNote, setWithdrawNote] = useState<string | null>(null);
  /**
   * 最近一次買入／賣出實際成交的每一步（含走哪個交易場所，cre8-app#47）。
   * 每次開始新的買入、賣出或清倉時清空；分批賣出時每成交一批就接在後面。
   */
  const [routes, setRoutes] = useState<{ action: 'deposit' | 'withdraw'; steps: RoutedStep[] } | null>(null);
  const recordTrades = (action: 'deposit' | 'withdraw', steps: readonly RoutedStep[]): void => {
    if (steps.length === 0) return;
    setRoutes((previous) => ({ action, steps: [...(previous?.action === action ? previous.steps : []), ...steps] }));
  };
  /** 賣出的每一批回來時記下它成交的步驟。只記 `executed`：被擋下或 revert 的那一批沒有成交。 */
  const recordSale = async (batch: Promise<RedeemResult>): Promise<RedeemResult> => {
    const result = await batch;
    if (result.outcome === 'executed') recordTrades('withdraw', result.steps);
    return result;
  };
  /**
   * 錢包（EOA）自己在鏈上的 USDT 餘額。
   *
   * 為什麼一定要顯示：存款失敗時 MetaMask 只會說「This transaction is likely to fail / Network fee
   * Unavailable」，完全看不出是 `BEP20: transfer amount exceeds balance`。實測就是餘額 999 卻要轉 1000。
   */
  const [walletUsdt, setWalletUsdt] = useState<bigint | null>(null);
  const [closing, setClosing] = useState(false);
  /**
   * Demo：不在開放清單上的基金是 whitelist-only。只要錢包連上就能操作到送出，
   * 送出時顯示 whitelist 提示，不簽名、不送交易（見 lib/live-funds.ts）。
   */
  // 提領/存款一律是真的鏈上交易 —— demo 期的 whitelist 閘門已移除。
  //
  // 為什麼移除：那個閘門用「slug 是不是範例基金」判斷，但範例基金與真策略是靠**名稱**對應的
  // （`elon-universe` → strategy 1）。結果是**已經在裡面有真錢**的使用者被鎖住，
  // 連提領都做不到 —— 對一個持有真部位的人來說這是最糟的失敗模式。
  //
  // 現在的行為：按下去就是真的簽名、真的送交易。要擋真錢請用後端或合約層，
  // 不要用一個「看起來像 UI」的開關去鎖既有資金。
  const whitelistOnly = false;
  const connectedAddress = useWallet((state) => state.address);
  const [whitelistNotice, setWhitelistNotice] = useState<TicketAction | null>(null);
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const [ticketProgress, setTicketProgress] = useState<{ scope: string; progress: TicketProgress } | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const ticketScope = `${slug}:${wallet?.address ?? ''}:${token !== null}`;
  const reviewMatches = mobile && reviewKey === `${ticketScope}:${tab}:${tab === 'deposit' ? amount : withdrawAmount}`;
  const progress = ticketProgress?.scope === ticketScope ? ticketProgress.progress : null;
  const ticketBusy = busy || withdrawBusy || closing;

  useEffect(() => {
    if (mobile && mobileTicket && (reviewMatches || progress !== null)) reviewHeading.current?.focus({ preventScroll: true });
  }, [mobile, mobileTicket, reviewMatches, progress !== null]);

  function showProgress(next: TicketProgress) {
    setTicketProgress({ scope: ticketScope, progress: next });
  }

  const walletAddress = wallet?.address ?? null;
  const usdtAddress = usdt?.address;
  const usdtDecimals = usdt?.decimals ?? 18;

  /**
   * 存款金額是否超過錢包餘額。
   *
   * 一定要在送出前擋：超過時鏈上是 `BEP20: transfer amount exceeds balance`，而 MetaMask 只會顯示
   * 「This transaction is likely to fail」＋「Network fee Unavailable」，看不出是餘額問題。
   */
  const depositTooLarge = (() => {
    if (walletUsdt === null) return false;
    try {
      const parsed = parseUnits(amount === '' ? '0' : amount, usdtDecimals);
      return parsed > walletUsdt;
    } catch {
      return false;
    }
  })();
  useEffect(() => {
    setWalletUsdt(null);
    if (wallet === null || usdtAddress === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const reader = publicClientFor(wallet);
        if (await reader.getChainId() !== CHAIN_ID) return;
        const balance = await reader.readContract({
          address: usdtAddress as Address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [wallet.address],
        });
        if (!cancelled) setWalletUsdt(balance as bigint);
      } catch {
        if (!cancelled) setWalletUsdt(null);
      }
    })();
    return () => { cancelled = true; };
  }, [wallet, usdtAddress]);

  const live = status.data;
  // 交易權限（session key）現在的狀態；My position 抽屜用。
  const permission = tradingPermissionHealth(live?.sessionKey);
  // A10（cre8-app#29）：這個帳戶在鏈上的 enroll／暫停／買入額度，以及 executor 的全域暫停。
  // 每一項讀不到都是 null（舊合約沒有這些函式），那一項就不顯示。
  const accountAddress = holding?.smartAccounts[0]?.address;
  const onchain = useAccountOnchain(wallet, live?.executorAddress, accountAddress);
  const onchainAccount = onchain.data?.account ?? null;
  const platformPaused = onchain.data?.globalPaused === true;
  const accountPaused = onchainAccount?.paused === true;
  const pauseSources =
    onchainAccount !== null && onchainAccount.pauseFlags !== null
      ? pauseSourcesFromFlags(onchainAccount.pauseFlags)
      : (live?.pauseSources ?? null);
  const buyWindow = onchain.data?.allowance ?? null;
  const buyLimit = buyWindow === null ? null : buyAllowanceState(buyWindow, Math.floor(Date.now() / 1000));
  const upgradeAvailable =
    onchainAccount !== null && onchainAccount.version > 0 && onchainAccount.latestVersion > onchainAccount.version;
  /** 資產位址 → 代號（鏈上讀回來的配置只有位址）。 */
  const symbolForAsset = (asset: string): string =>
    (assets.data ?? []).find((row) => row.address.toLowerCase() === asset.toLowerCase())?.symbol ??
    (live?.targets ?? []).find((row) => row.asset.toLowerCase() === asset.toLowerCase())?.symbol ??
    shortAddress(asset);
  /** 把 A10 的合約錯誤換成看得懂的話；認不出來就原樣回傳。 */
  const friendlyFailure = (message: string): string =>
    explainA10Failure(message, { pauseSources, nextBuyAt: buyLimit?.nextBuyAt ?? null }) ?? message;

  /**
   * 讀「哪些資產還沒授權給 executor」。
   *
   * 為什麼要獨立成一個 effect：`blocked: ALLOWANCE_TOO_LOW` 是後端在**送交易前**才發現的，
   * 使用者當下看到的是一句看不懂的英文。把這件事提前到畫面上，他才會知道「按這顆按鈕就好」。
   *
   * `null` 代表「還沒讀完」—— 不要用空陣列假裝「都授權好了」，那會讓 UI 在載入中說謊。
   */
  const executorForAllowance = live?.executorAddress ?? null;
  const accountForAllowance = live?.account ?? null;
  const assetRows = live?.drift.assets ?? [];
  /** 用字串當依賴：陣列每次 render 都是新參考，會讓 effect 無限重跑。 */
  const assetKey = assetRows.map((row) => row.asset.toLowerCase()).join(',');
  useEffect(() => {
    if (wallet === null || executorForAllowance === null || accountForAllowance === null || assetKey === '') {
      setUnapproved(null);
      return;
    }
    setUnapproved(null);
    let cancelled = false;
    void (async () => {
      const reader = publicClientFor(wallet);
      if (await reader.getChainId() !== CHAIN_ID) return;
      const missing = (
        await Promise.all(
          assetRows.map(async (row) => {
            const allowance = await reader
              .readContract({
                address: row.asset as Address,
                abi: ERC20_ABI,
                functionName: 'allowance',
                args: [accountForAllowance as Address, executorForAllowance as Address],
              })
              .catch(() => 0n);
            return allowance > 0n ? null : row.symbol;
          }),
        )
      ).filter((symbol): symbol is string => symbol !== null);
      if (!cancelled) setUnapproved(missing);
    })().catch(() => {
      if (!cancelled) setUnapproved(null);
    });
    return () => {
      cancelled = true;
    };
    // assetRows 用 assetKey 代表；其他依賴都是原始值。
  }, [accountForAllowance, assetKey, executorForAllowance, wallet]);

  /**
   * 是否**真的持有**這個基金（而不是「有一列投組但裡面是空的」）。
   *
   * 清倉之後帳戶價值 0、持倉 0 檔，但 DB 的 portfolio 列還在。只看 `holding !== undefined` 的話，
   * 「My position」按鈕與那份空持倉表會留在畫面上（實測：清倉後仍顯示 0 資產、drift 5000 bps）——
   * 使用者錢都提出來了，畫面上不該再宣稱他持有。
   */
  const held =
    holding !== undefined &&
    (live === undefined || Number(live.totalUsdE8 ?? '0') > 0 || live.holdings.length > 0);
  // id 模式（`/funds/strategy/:id`）沒有 slug，`fund` 是由 community 策略合成的 ——
  // 合成之前（資料還在載入）不能走這個早退，否則會顯示 `No fund with slug ""`。
  // 合成失敗或策略不存在時才落到錯誤分支。
  if (fund === undefined && strategyId !== null) {
    // 策略還在載入（或查不到）：給一個明確的等待／錯誤畫面，而不是白屏。
    return (
      <main className="wrap vault-content">
        {communityStrategy.isPending ? (
          <div className="row">
            <Spinner /> <span className="muted">Loading strategy…</span>
          </div>
        ) : communityStrategy.error !== null && communityStrategy.error !== undefined ? (
          <ErrorNote error={communityStrategy.error} />
        ) : (
          <>
            <Note tone="bad">No strategy #{strategyId}.</Note>
            <p>
              <Link to="/vaults">← All funds</Link>
            </p>
          </>
        )}
      </main>
    );
  }
  if (fund === undefined) {
    return (
      <main className="wrap vault-content">
        <Note tone="bad">No fund with slug “{slug}”.</Note>
        <p>
          <Link to="/vaults">← All funds</Link>
        </p>
      </main>
    );
  }

  const rows = live === undefined
    ? (reference?catalogueTargets(reference):fund.holdings).map((row) => ({ symbol: row.symbol, targetBps: row.weightBps, currentBps: null as number | null }))
    : (live.drift.assets ?? []).map((row) => ({ symbol: row.symbol, targetBps: row.targetBps, currentBps: row.currentBps }));


  const withdrawLoadError = strategies.error ?? portfolios.error ?? status.error;
  const withdrawLoading = strategies.isPending || portfolios.isPending ||
    (holding !== undefined && status.isPending);
  const depositLoadError = strategies.error ?? assets.error;
  const reviewId = `${ticketScope}:${tab}:${tab === 'deposit' ? amount : withdrawAmount}`;
  const depositUnits = mobile && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(amount)
    ? parseUnits(amount, usdtDecimals)
    : 0n;
  const withdrawRequested = Number(withdrawAmount);
  const withdrawValid = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(withdrawAmount) &&
    Number.isFinite(withdrawRequested) && withdrawRequested > 0.000001;
  const withdrawLimit = Math.min(withdrawRequested, totalUsd());
  const gatedDepositValid = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(amount) && Number(amount) > 0;

  function openMobileTicket(action: TicketAction) {
    setReviewKey(null);
    setTicketProgress(null);
    setTab(action);
    setTicketOpen(true);
  }

  function submitTicket(action: TicketAction) {
    if (ticketBusy) return;
    if (whitelistOnly) {
      if (connectedAddress === null) return;
      if (action === 'deposit' && !gatedDepositValid) return;
      if (action === 'withdraw' && !withdrawValid) return;
      if (mobile && !reviewMatches) {
        setReviewKey(reviewId);
        return;
      }
      setReviewKey(null);
      if (mobile) {
        showProgress({ tone: 'notice', title: WHITELIST_COPY.title, detail: WHITELIST_COPY[action], restricted: true });
      } else {
        setWhitelistNotice(action);
      }
      return;
    }
    if (mobile) {
      if (token === null || wallet === null || usdt === undefined) return;
      if (action === 'deposit' && (depositUnits <= 0n || depositTooLarge || strategy === undefined)) return;
      if (action === 'withdraw' && (!withdrawValid || live === undefined || !live.complete || withdrawLimit <= 0.000001)) return;
      if (!reviewMatches) {
        setReviewKey(reviewId);
        return;
      }
    }
    setReviewKey(null);
    if (action === 'deposit') void deposit();
    else void withdraw();
  }

  const cover = reference ? REFERENCE_METADATA[reference.slug]?.cover : undefined;
  const ticketFund = (
    <TicketFund name={fund.name} image={cover ? { src: cover.thumbnailSrc, position: cover.thumbnailPosition } : undefined} />
  );
  const depositPresets = walletUsdt === null ? [] : ['25', '100'].filter(
    (preset) => parseUnits(preset, usdtDecimals) <= walletUsdt,
  );

  const ticket = (<>
            <section className="panel ticket" id="ticket">
              {/* Radix Tabs 取代手寫的 role="tablist" + 兩顆 button：拿到鍵盤左右鍵切換、
                  `aria-selected`、`tabIndex` 管理。內容仍是同一個三元式（不改 TabsContent）——
                  那份內容很長，重排只增加 diff 而不增加正確性。 */}
              {/* 畫面上叫 Buy／Sell（2026-11-13 使用者決定，比 Deposit／Withdraw 好懂）；
                  程式內部、網址參數與 API 仍是 deposit／withdraw。 */}
              <Tabs value={tab} onValueChange={(value) => setTab(value as 'deposit' | 'withdraw')}>
                {!mobile && (
                  <TabsList aria-label="Fund actions" className="w-full bg-[var(--card,#eef3f7)]">
                    <TabsTrigger value="deposit" className="flex-1">Buy</TabsTrigger>
                    <TabsTrigger value="withdraw" className="flex-1">Sell</TabsTrigger>
                  </TabsList>
                )}
              <div className="panel-b">
                {tab === 'withdraw' ? (
                  !whitelistOnly && token !== null && withdrawLoadError !== null ? (
                    <ErrorNote error={withdrawLoadError} />
                  ) : !whitelistOnly && token !== null && withdrawLoading ? (
                    <div className="row">
                      <Spinner /> <span className="muted">Reading balances…</span>
                    </div>
                  ) : !whitelistOnly && token !== null && holding === undefined ? (
                    <Note>This wallet has no position in this fund.</Note>
                  ) : (
                    <form
                      className="swap"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitTicket('withdraw');
                      }}
                    >
                      <div className="swap-box">
                        <div className="swap-head">
                          <label className="swap-label" htmlFor="withdraw-amount">
                            {mobile ? 'Amount' : 'You receive'}
                          </label>
                          <span className="swap-picks">
                            <button type="button" disabled={live === undefined} onClick={() => setWithdrawAmount(maxWithdrawLabel())}>
                              Max
                            </button>
                          </span>
                        </div>
                        <input
                          id="withdraw-amount"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0"
                          value={withdrawAmount}
                          onChange={(event) => setWithdrawAmount(event.target.value)}
                        />
                        {mobile ? (
                          <>
                            <span className="app-ticket-currency">USDT</span>
                            {live !== undefined && <span className="swap-sub">Fund value {formatUsd(totalUsd())}</span>}
                          </>
                        ) : <span className="swap-sub">USDT → {walletAddress === null ? 'your wallet' : shortAddress(walletAddress)}</span>}
                      </div>
                      {whitelistOnly ? (
                        connectedAddress === null ? <WalletMenu inline /> : (
                          <>
                            <button type="submit" className="btn primary block" disabled={!withdrawValid}>
                              {mobile ? 'Review order' : 'Sell for USDT'}
                            </button>
                            {whitelistNotice === 'withdraw' && <WhitelistNote action="withdraw" />}
                          </>
                        )
                      ) : token === null ? <WalletMenu inline /> : (
                        <>
                          {!mobile && <p className="fine">
                            Cash {formatUsd(cashUsd())} · positions {formatUsd(Math.max(0, totalUsd() - cashUsd()))} · total{' '}
                            {formatUsd(totalUsd())}
                            {withdrawAmount !== '' && Number(withdrawAmount) > cashUsd() ? (
                              <>
                                <br />
                                The shortfall {formatUsd(Number(withdrawAmount) - cashUsd())} is sold from every position
                                pro-rata first, so the fund stays on its mandate.
                              </>
                            ) : null}
                          </p>}
                          <button
                            type="submit"
                            className={mobile ? 'btn primary block' : 'btn ghost block'}
                            disabled={ticketBusy || wallet === null || live === undefined || totalUsd() === 0 ||
                              (mobile && (!withdrawValid || usdt === undefined || !live.complete))}
                          >
                            {withdrawBusy ? 'Working…' : mobile ? 'Review order' : 'Sell for USDT'}
                          </button>
                          {totalUsd() === 0 ? <p className="fine">This fund account has no balance.</p> : null}
                          {live !== undefined && gasTooLow(live) ? (
                            <p className="fine">
                              Add BNB in My position for network fees.
                            </p>
                          ) : null}
                          {(platformPaused || accountPaused) && (
                            <>
                              <p className="fine warn" role="status">
                                {platformPaused ? PLATFORM_PAUSED_MESSAGE : `${describePause(pauseSources)} The fund cannot sell for you while it is paused.`}
                              </p>
                              {/* 暫停時賣不了，但錢還是使用者的：不經過賣出，直接把帳戶裡的代幣原樣送回錢包。 */}
                              <button
                                type="button"
                                className="btn ghost block"
                                disabled={ticketBusy || wallet === null || totalUsd() === 0}
                                onClick={() => void closeAll({ skipSell: true })}
                                title="Send every token in this account to your wallet as it is, without selling"
                              >
                                {closing ? 'Sending…' : 'Withdraw assets without selling'}
                              </button>
                            </>
                          )}
                          {withdrawNote === null ? null : <p className="fine warn">{withdrawNote}</p>}
                          {withdrawTx === null ? null : (
                            <p className="fine">
                              Withdrawn. tx <span className="mono">{withdrawTx}</span>
                            </p>
                          )}
                          {/* 手機的清倉沒有收據畫面，所以這一塊跟上面的「Withdrawn. tx」一樣不分桌機手機都顯示。 */}
                          {routes?.action === 'withdraw' && (
                            <TradeRoutes steps={routes.steps} symbolOf={symbolForAsset} title="Where your positions were sold" />
                          )}
                          <ErrorNote error={withdrawError} />
                          {/* 清倉：把全部部位賣成 USDT，再把 USDT 與所有殘留的股票代幣（塵埃）掃回錢包。 */}
                          <button
                            type="button"
                            className="btn ghost block app-ticket-close-position"
                            disabled={ticketBusy || wallet === null || totalUsd() === 0}
                            onClick={() => void closeAll()}
                            style={{ marginTop: 8 }}
                            title="Sell everything to USDT, then send the USDT and every leftover token back to your wallet"
                          >
                            {closing ? 'Closing…' : 'Close position'}
                          </button>
                          <p className="fine">
                            {mobile
                              ? 'Sells all holdings and returns the balance to your wallet.'
                              : 'If there isn’t enough cash, the fund sells part of each position. You then approve the USDT transfer.'}
                          </p>
                        </>
                      )}
                    </form>
                  )
                ) : !whitelistOnly && token !== null && depositLoadError !== null ? (
                  <ErrorNote error={depositLoadError} />
                ) : !whitelistOnly && token !== null && (strategies.isPending || assets.isPending) ? (
                  <div className="row"><Spinner /> <span className="muted">Loading order details…</span></div>
                ) : !whitelistOnly && token !== null && strategy === undefined ? (
                  <Note>
                    This fund exists only as an example in the catalogue — nobody has published it on-chain yet, so
                    there is nothing to deposit into.
                  </Note>
                ) : (
                  /* 沒有「先 Follow 再 Deposit」這一步 —— 存款就是跟隨。
                     未持有時按 Deposit 會先建帳戶（enroll）再轉 USDT，使用者不必理解 enroll 這個概念。 */
                  <form
                    className="swap"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitTicket('deposit');
                    }}
                  >
                    <div className="swap-box">
                      <div className="swap-head">
                        <label className="swap-label" htmlFor="deposit-amount">
                          {mobile ? 'Amount' : 'You pay'}
                        </label>

                      </div>
                      <input
                        id="deposit-amount"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                      />
                      {mobile && <span className="app-ticket-currency">{usdt?.symbol ?? 'USDT'}</span>}
                      {(!mobile || token !== null) && (
                        <span className="swap-sub">
                          {!mobile && <span>
                            {usdt?.symbol ?? 'USDT'} →{' '}
                            {holding === undefined
                              ? 'your new account'
                              : shortAddress(holding.smartAccounts[0]?.address ?? '')}
                          </span>}
                          {token !== null && <span className="vault-balance-value">
                            {mobile ? 'Balance ' : '· balance '}
                            {walletUsdt === null
                              ? '—'
                              : Number(formatUnits(walletUsdt, usdtDecimals)).toLocaleString('en-US', { maximumFractionDigits: 4 })}{' '}
                            {usdt?.symbol ?? 'USDT'}
                          </span>}
                        </span>
                      )}
                      {depositTooLarge ? (
                        <p className="fine neg" style={{ margin: '6px 0 0' }}>
                          This amount exceeds your wallet balance.
                        </p>
                      ) : null}
                    </div>
                    {/* 常用金額一鍵帶入（桌面與手機都有；原本桌面只有一顆 Max）。 */}
                    {walletUsdt !== null && (
                      <div className="app-ticket-presets" aria-label="Buy amount shortcuts" role="group">
                        {depositPresets.map((preset) => (
                          <button type="button" key={preset} aria-label={`Set amount to ${preset} USDT`} onClick={() => setAmount(preset)}>{preset}</button>
                        ))}
                        <button type="button" onClick={() => setAmount(maxDepositLabel())}>Max</button>
                      </div>
                    )}
                    {whitelistOnly ? (
                      connectedAddress === null ? <WalletMenu inline /> : (
                        <>
                          <button type="submit" className="btn primary block" disabled={!gatedDepositValid}>
                            {mobile ? 'Review order' : 'Buy'}
                          </button>
                          {whitelistNotice === 'deposit' && <WhitelistNote action="deposit" />}
                        </>
                      )
                    ) : token === null ? <WalletMenu inline /> : (
                      <button type="submit" className="btn primary block" disabled={ticketBusy || wallet === null || usdt === undefined || depositTooLarge || (mobile && depositUnits <= 0n)}>
                        {busy ? 'Sending…' : mobile ? 'Review order' : 'Buy'}
                      </button>
                    )}
                    {token !== null && platformPaused && <p className="fine warn" role="status">{PLATFORM_PAUSED_MESSAGE}</p>}
                    {token !== null && !platformPaused && accountPaused && (
                      <p className="fine warn" role="status">
                        {describePause(pauseSources)} New money stays in USDT until trading is resumed.{' '}
                        <button type="button" className="link-button" onClick={() => setMyPosition(true)}>Open My position</button>
                      </p>
                    )}
                    {token !== null && !platformPaused && !accountPaused && buyLimit?.exhausted === true && (
                      <p className="fine warn" role="status">
                        {buyLimitMessage(buyLimit.nextBuyAt)} New money stays in USDT until then.
                      </p>
                    )}
                    {token !== null && upgradeAvailable && onchainAccount !== null && (
                      <p className="fine" role="status">
                        Version {onchainAccount.latestVersion} of this fund is available; your account is on version {onchainAccount.version}.{' '}
                        <button type="button" className="link-button" onClick={() => setMyPosition(true)}>Review the update</button>
                      </p>
                    )}
                    {!mobile && routes?.action === 'deposit' && (
                      <TradeRoutes steps={routes.steps} symbolOf={symbolForAsset} title="Where your purchase traded" />
                    )}
                    <ErrorNote error={error} />
                  </form>
                )}
                </div>
              </Tabs>
            </section>


  </>);

  return (
    <>
      <main className="wrap vault-content">
        <div className="vgrid">
          <div className="main">{reference&&<FundOverview key={reference.slug} fund={reference} backTo={backTo} factsTrigger={factsTrigger} onFacts={()=>setFacts(true)} onPosition={()=>setMyPosition(true)} held={held}/>}</div>

          {mobile ? (
            <AppBottomSheet
              open={mobileTicket}
              onOpenChange={(open) => {
                if (!open) setReviewKey(null);
                setTicketOpen(open);
              }}
              title={reviewMatches ? 'Review order' : tab === 'deposit' ? 'Buy' : 'Sell'}
              hideTitle={progress !== null}
              titleRef={reviewHeading}
              locked={ticketBusy}
            >
              {progress !== null ? (
                <TicketReceipt
                  fund={ticketFund}
                  progress={progress}
                  busy={ticketBusy}
                  explorerUrl={CHAIN_ID === 56 ? 'https://bscscan.com' : undefined}
                  extra={routes !== null && routes.action === tab && progress.tone !== 'pending' ? (
                    <TradeRoutes
                      steps={routes.steps}
                      symbolOf={symbolForAsset}
                      title={tab === 'deposit' ? 'Where your purchase traded' : 'Where your positions were sold'}
                    />
                  ) : undefined}
                  onDone={() => setTicketOpen(false)}
                  onViewPortfolio={dismissTicketToast}
                  onBack={() => {
                    dismissTicketToast();
                    setTicketProgress(null);
                  }}
                />
              ) : (
                <>
                  {ticketFund}
                  {reviewMatches ? <TicketReview
                    action={tab}
                    amount={tab === 'deposit'
                      ? `${whitelistOnly ? Number(amount).toLocaleString('en-US', { maximumFractionDigits: 6 }) : formatUnits(depositUnits, usdtDecimals)} ${usdt?.symbol ?? 'USDT'}`
                      : `${(whitelistOnly ? withdrawRequested : withdrawLimit).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDT`}
                    destination={tab === 'deposit' ? (holding?.smartAccounts[0]?.address ?? 'Your new fund account') : (walletAddress ?? 'Your wallet')}
                    network={appChain.name}
                    note={whitelistOnly ? undefined : tab === 'deposit'
                      ? 'Your wallet may also ask for a BNB top-up or token approval.'
                      : [
                        withdrawRequested > totalUsd() && 'Limited to the current fund value.',
                        withdrawLimit > cashUsd() && 'The fund may sell holdings to pay you out. The final amount can change.',
                      ].filter(Boolean).join(' ')}
                    onEdit={() => setReviewKey(null)}
                    onConfirm={() => submitTicket(tab)}
                  /> : ticket}
                </>
              )}
            </AppBottomSheet>
          ) : <aside className="side">{ticket}{reference && <FundSnapshot fund={reference} />}</aside>}
          <div className="public-mobile-cta" aria-label="Fund actions" role="group">
            <button className="btn" type="button" aria-haspopup="dialog" disabled={ticketBusy} onClick={() => openMobileTicket('deposit')}>Buy</button>
            <button className="btn ghost" type="button" aria-haspopup="dialog" disabled={ticketBusy} onClick={() => openMobileTicket('withdraw')}>Sell</button>
          </div>
        </div>
      </main>


      {/* My position：這個投組的即時狀態。沿用 Fund facts 的抽屜樣式（dialog.pros-drawer）。 */}
      {/*
        為什麼用 shadcn 的 Sheet 而不是自己寫 <dialog>：手寫版只有 Esc 能關，
        沒有 focus trap（Tab 會跑到背後的頁面）、也沒有背景鎖捲動。
        Radix 這些都處理好了，而且保留原本的 .pros-head / .pros-body 內容樣式。
      */}
      <Sheet open={myPosition && live !== undefined} onOpenChange={setMyPosition}>
        <SheetContent side={mobile ? 'bottom' : 'right'} showCloseButton={!mobile} className={mobile ? 'app-bottom-sheet app-fund-info-sheet' : 'w-full gap-0 overflow-y-auto p-0 sm:max-w-xl'}>
          <SheetHeader>
            {!mobile && <p className="label">[ My position ]</p>}
            <SheetTitle>Portfolio #{live?.portfolioId ?? '—'}</SheetTitle>
            <SheetDescription className="sr-only">Current fund holdings and account status.</SheetDescription>
            {mobile && <AppSheetClose />}
          </SheetHeader>
          <div className="pros-body" style={mobile ? undefined : { padding: '20px 24px' }}>
            {live === undefined ? (
              <p className="fine">No live status for this account yet.</p>
            ) : (
              <>
            <section className="panel pros-sec">
              <div className="panel-h">
                <h3>Status</h3>
                <span className="label">block #{live.block}</span>
              </div>
              <div className="panel-b">
                <dl className="kv">
                  <dt>account</dt>
                  <dd className="mono">{live.account}</dd>
                  <dt>total value</dt>
                  <dd>{formatUsd(totalUsd())}</dd>
                  <dt>gross drift</dt>
                  <dd>
                    {live.drift.grossDriftBps} bps / threshold {live.drift.thresholdBps} bps / needs rebalance:{' '}
                    {live.drift.needsRebalance ? 'yes' : 'no'}
                  </dd>
                  <dt>executor approval</dt>
                  <dd>
                    {unapproved === null ? (
                      <span className="muted">checking…</span>
                    ) : unapproved.length === 0 ? (
                      <Badge tone="ok">approved</Badge>
                    ) : (
                      <>
                        <Badge tone="warn">{unapproved.length} asset{unapproved.length === 1 ? '' : 's'} not approved</Badge>
                        <div className="fine neg" style={{ marginTop: 4 }}>
                          The executor cannot pull {unapproved.join(', ')} — a rebalance will be blocked until you
                          approve. Your money is safe; it just cannot be invested.
                        </div>
                        <button
                          type="button"
                          className="btn ghost sm"
                          style={{ marginTop: 6 }}
                          disabled={approving}
                          onClick={() => void approveMissingAssets()}
                        >
                          {approving ? 'Approving…' : `Approve ${unapproved.length} asset${unapproved.length === 1 ? '' : 's'}`}
                        </button>
                      </>
                    )}
                  </dd>
                  <dt>gas</dt>
                  <dd>
                    {live.gas === null || live.gas.balanceWei === null || live.gas.balanceWei === undefined
                      ? 'unknown'
                      : `${Number(formatEther(BigInt(live.gas.balanceWei))).toFixed(6)} BNB`}
                    {wallet === null ? null : (
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={{ marginLeft: 8 }}
                        disabled={toppingUp}
                        onClick={() => void topUpGas()}
                      >
                        {toppingUp ? 'Topping up…' : 'Top up 0.0005 BNB'}
                      </button>
                    )}
                  </dd>
                  <dt>trading permission</dt>
                  <dd id="trading-permission">
                    <Badge tone={permission.tone}>{permission.label}</Badge>
                    <div className={`fine${permission.tone === 'bad' ? ' neg' : ''}`} style={{ marginTop: 4 }}>
                      {permission.detail}
                    </div>
                    {wallet === null ? null : (
                      <button
                        type="button"
                        className={permission.needsAction ? 'btn sm' : 'btn ghost sm'}
                        style={{ marginTop: 6 }}
                        disabled={renewing}
                        onClick={() => void renewPermission()}
                      >
                        {renewing ? 'Renewing…' : permission.needsAction ? 'Renew permission' : 'Renew now'}
                      </button>
                    )}
                    <div className="fine" style={{ marginTop: 6 }}>
                      One wallet signature. Also use it if selling fails because the permission is no longer accepted.
                    </div>
                    {renewNote === null ? null : (
                      <div className="fine pos" role="status" style={{ marginTop: 6 }}>{renewNote}</div>
                    )}
                  </dd>
                </dl>
                <ErrorNote error={error} />
              </div>
            </section>

            <AccountControls
              wallet={wallet}
              token={token}
              account={live.account}
              executor={live.executorAddress}
              dbStrategyId={holding?.strategyId ?? strategy?.id ?? 0}
              onchain={onchain.data}
              loading={onchain.isPending}
              backendPauseSources={live.pauseSources ?? null}
              symbolOf={symbolForAsset}
              usdtDecimals={usdtDecimals}
              usdtSymbol={usdt?.symbol ?? 'USDT'}
              onChanged={async () => {
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: accountOnchainKey(live.executorAddress, live.account) }),
                  queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
                  queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' }),
                ]);
              }}
            />

            <section className="panel pros-sec">
              <div className="panel-h">
                <h3>Holdings</h3>
                <span className="label">{live.holdings.length} assets</span>
              </div>
              <div className="panel-b">
                <table className="dk-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th className="num">Target bps</th>
                      <th className="num">Current bps</th>
                      <th className="num">Delta</th>
                      <th className="num">USD value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.drift.assets.map((row) => (
                      <tr key={row.symbol}>
                        <td className="mono">
                          <strong>{row.symbol}</strong>
                        </td>
                        <td className="num">{row.targetBps}</td>
                        <td className="num">{row.currentBps}</td>
                        <td className={`num ${row.deltaBps > 0 ? 'pos' : row.deltaBps < 0 ? 'neg' : ''}`}>
                          {row.deltaBps > 0 ? '+' : ''}
                          {row.deltaBps} bps
                        </td>
                        <td className="num">{formatUsd(Number(row.usdValueE8) / 1e8)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={facts} onOpenChange={setFacts}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="app-fund-facts-sheet w-full gap-0 overflow-hidden p-0 sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            if (factsTrigger.current !== null) {
              event.preventDefault();
              factsTrigger.current.focus({ preventScroll: true });
            }
          }}
        >
          <SheetHeader>
            <p className="app-facts-label">Fund facts</p>
            <SheetTitle>{fund.name}</SheetTitle>
            <SheetDescription className="sr-only">Fees, strategy, and fund information.</SheetDescription>
            <AppSheetClose />
          </SheetHeader>
          <nav className="app-facts-navigation" aria-label="Fund facts sections" onClick={(event) => {
            const link = (event.target as Element).closest('a');
            const section = link?.hash ? document.getElementById(link.hash.slice(1)) : null;
            if (!section) return;
            event.preventDefault();
            event.currentTarget.querySelector('details')?.removeAttribute('open');
            section.scrollIntoView({ block: 'start', behavior: 'instant' });
            section.focus({ preventScroll: true });
          }}>
            <a href="#facts-overview">Overview</a>
            <a href="#facts-fees">Fees</a>
            <a href="#facts-strategy">Strategy</a>
            <details>
              <summary>More</summary>
              <div>
                <a href="#facts-performance">Performance &amp; data</a>
                <a href="#facts-positions">Positions</a>
                <a href="#facts-creator">Creator</a>
                <a href="#facts-contracts">Contracts</a>
              </div>
            </details>
          </nav>
          <div className="pros-body">
            <section id="facts-overview" className="panel pros-sec" tabIndex={-1}>
              <div className="panel-h"><h3>At a glance</h3></div>
              <div className="panel-b">
                <dl className="app-facts-overview">
                  {modelPerformanceFee !== null && <div><dt>Model fees</dt><dd>{modelPerformanceFee}% of realized profit</dd></div>}
                  <div><dt>Allocation</dt><dd>{fund.thesis}</dd></div>
                  <div><dt>Rebalancing</dt><dd>{reference?.sourceModel ? 'Source updates' : fund.rebalance === 'none' ? 'No fixed schedule' : fund.rebalance === 'drift' ? 'On allocation drift' : 'Monthly'}</dd></div>
                  <div><dt>Execution</dt><dd>{strategy === undefined ? 'Catalogue model' : `Connected to strategy #${strategy.id}`}</dd></div>
                </dl>
              </div>
            </section>
            <section id="facts-fees" className="panel pros-sec" tabIndex={-1}>
              <div className="panel-h"><h3>Fees &amp; terms</h3></div>
              <div className="panel-b">
                {modelFees || strategy ? (
                  <dl className="app-facts-overview">
                    {modelFees && (
                      <>
                        <div><dt>Model performance fee</dt><dd>{modelPerformanceFee}% of realized profit</dd></div>
                        <div><dt>Model management fee</dt><dd>{modelFees.mgmt}%</dd></div>
                      </>
                    )}
                    {strategy && <div><dt>Live strategy swap fee</dt><dd>{pct(strategy.swapFeeBps)}</dd></div>}
                  </dl>
                ) : <p className="fine">Fee terms unavailable.</p>}
              </div>
            </section>
            <section id="facts-strategy" className="panel pros-sec vault-mandate" tabIndex={-1}>
              <div className="panel-h"><h3>Strategy</h3></div>
              <div className="panel-b">
                <table className="dk-table vault-where" style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Target</th>
                      <th>Tradable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const meta = (assets.data ?? []).find((asset) => asset.symbol === row.symbol);
                      return (
                        <tr key={row.symbol}>
                          <td className="mono">
                            <strong>{row.symbol}</strong>
                          </td>
                          <td>{row.targetBps} bps</td>
                          <td>{meta === undefined ? '—' : meta.tradable === true ? 'yes' : meta.tradable === false ? 'no oracle' : 'unknown'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="fine">
                  A version is immutable: changing weights means publishing a new version, and every follower keeps the
                  version it pinned until it re-enrolls.
                </p>
              </div>
            </section>

            <section id="facts-performance" className="panel pros-sec" tabIndex={-1}>
              <div className="panel-h"><h3>Performance &amp; data</h3></div>
              <div className="panel-b">
                <p className="fine">Model performance before fees.</p>
                <dl className="kv"><dt>All-time max drawdown</dt><dd>{reference === undefined ? '—' : pct((periodMetrics(reference, 'ALL').maxDrawdown ?? 0) * 100)}</dd></dl>
              </div>
            </section>
            <section id="facts-positions" className="panel pros-sec vault-positions" tabIndex={-1}>
              <div className="panel-h">
                <h3>Positions</h3>
                <span className="label">{live === undefined ? '' : `block #${live.block}`}</span>
              </div>
              <div className="panel-b">
                {live === undefined ? (
                  <p className="fine">
                    No live positions — {holding === undefined ? 'you do not hold this fund yet' : 'the status could not be read'}.
                  </p>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th className="r">Balance</th>
                        <th className="r">Value (USDT)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {live.holdings.map((row: PortfolioStatus['holdings'][number]) => (
                        <tr key={row.asset}>
                          <td className="mono">{row.symbol}</td>
                          <td className="r">{formatUnits(BigInt(row.amountWei), row.decimals)}</td>
                          <td className="r">${(Number(row.usdValueE8) / 1e8).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section id="facts-creator" className="panel pros-sec vault-creator-card" tabIndex={-1}>
              <div className="panel-h">
                <h3>Creator</h3>
              </div>
              <div className="panel-b">
                <p className="vcc-id">
                  <img src="/logos/cre8-icon.svg" alt="" width="32" height="32" />
                  <span>
                    <b>{strategy === undefined ? 'CRE8 catalogue' : shortAddress(strategy.provider)}</b>
                    <small>{strategy === undefined ? 'Design reference only' : `Strategy #${strategy.id}`}</small>
                  </span>
                </p>
                <dl className="vcc-stats">
                  <div>
                    <dt>Funds created</dt>
                    <dd>{strategies.data?.items.length ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Followers</dt>
                    <dd>{(portfolios.data ?? []).filter((row) => row.strategyId === strategy?.id).length}</dd>
                  </div>
                </dl>
              </div>
            </section>

            <section id="facts-contracts" className="panel pros-sec vault-identity" tabIndex={-1}>
              <div className="panel-h">
                <h3>Identity &amp; contracts</h3>
              </div>
              <div className="panel-b">
                <dl className="kv">
                  <dt>strategy</dt>
                  <dd className="mono">{strategy === undefined ? 'not published' : `#${strategy.id} (registry ${strategy.onchainId ?? '—'})`}</dd>
                  <dt>account</dt>
                  <dd className="mono">{holding?.smartAccounts[0]?.address ?? '—'}</dd>
                  <dt>executor</dt>
                  <dd className="mono">{live?.executorAddress ?? '—'}</dd>
                  <dt>session key</dt>
                  <dd className="mono">{live?.sessionKey?.usable?.keyRef ?? '—'}</dd>
                </dl>
              </div>
            </section>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );

  /**
   * 讀鏈上的 enrollment 並與畫面上這檔基金比對（給 `deposit` 的首次存入前檢查用）。
   *
   * 回傳 `blocked`（不該轉錢的理由）或 `line`（要顯示給使用者的一句話）；兩個都是 null 代表「讀不到，不擋」。
   */
  async function verifyEnrollment(
    account: Address,
    portfolioId: number | null,
  ): Promise<{ blocked: string | null; line: string | null }> {
    const unknown = { blocked: null, line: null };
    if (wallet === null || token === null || strategy === undefined) return unknown;
    try {
      const executor =
        live?.executorAddress ??
        (portfolioId === null ? null : (await getPortfolioStatus(token, portfolioId)).executorAddress);
      if (executor === null || executor === undefined) return unknown;
      // operator 的 enroll 剛上鏈時，錢包的 RPC 可能還沒看到：多問兩次再放棄。
      let state = (await loadAccountOnchain(wallet, executor as Address, account)).account;
      for (let attempt = 0; attempt < 2 && state !== null && state.version === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        state = (await loadAccountOnchain(wallet, executor as Address, account)).account;
      }
      if (state === null || state.version === 0 || state.current === null) return unknown;

      // 這一檔在後端發布過的每一版配置。鏈上釘的那一版必須是其中之一
      // （不比版本號：後端與鏈上的編號是各自遞增的，沒有保證逐一相等）。
      const published = (await getStrategy(token, strategy.id).catch(() => null))?.versions ?? [];
      const known = published.map((version) =>
        version.allocation.assets.map((asset) => ({ asset: asset.address, weightBps: asset.weightBps })),
      );
      const onchainAllocation = state.current;
      const matching = known.find((allocation) => sameAllocation(onchainAllocation, allocation)) ?? null;
      const check = checkEnrollment({
        expectedStrategyId: strategy.onchainId === null ? state.strategyId : BigInt(strategy.onchainId),
        onchainStrategyId: state.strategyId,
        onchainVersion: state.version,
        onchainAllocation,
        expectedAllocation: known.length === 0 ? null : (matching ?? known[0] ?? null),
      });
      if (!check.ok) return { blocked: check.reason, line: null };
      const assetsLine = [...onchainAllocation]
        .sort((a, b) => b.weightBps - a.weightBps)
        .map((row) => `${symbolForAsset(row.asset)} ${(row.weightBps / 100).toFixed(row.weightBps % 100 === 0 ? 0 : 2)}%`)
        .join(' · ');
      return { blocked: null, line: `On-chain: fund #${state.strategyId} version ${state.version} — ${assetsLine}` };
    } catch {
      return unknown;
    }
  }

  async function deposit(): Promise<void> {
    if (wallet === null || token === null || strategy === undefined || usdt === undefined) return;
    setBusy(true);
    setError(null);
    setRoutes(null);
    const toastId = toast.pending('Buy', 'Preparing…');
    if (mobile) ticketToast.current = toastId;
    let transferHash: string | undefined;
    let transferState: 'submitted' | 'confirmed' | 'reverted' = 'submitted';
    let allocation = 'Check Portfolio for the latest allocation.';
    showProgress({ tone: 'pending', title: 'Preparing your purchase', detail: 'Follow the prompts in your wallet.' });
    try {
      // 沒有帳戶就先建（enroll）——「存款就是跟隨」，使用者不必先理解 enroll。
      // 位址是 counterfactual 的：同一個 (owner, strategy) 永遠同一個地址，所以建好之後
      // 之後所有存款都進同一個帳戶。
      let account = holding?.smartAccounts[0]?.address;
      // enroll 後才知道 portfolioId；deposit 結束時要對它跑一輪配置。
      let portfolioIdAfterEnroll: number | null = holding?.id ?? null;
      if (account === undefined) {
        toast.replace(toastId, {
          tone: 'pending',
          title: 'Creating your account',
          body: 'One account per owner and strategy…',
        });
        const created = await enrollPortfolio(token, strategy.id);
        account = created.smartAccounts[0]?.address;
        portfolioIdAfterEnroll = created.id;
        if (account === undefined) throw new Error('the backend returned no smart account address');
        await queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) });
        toast.replace(toastId, { tone: 'pending', title: 'Buy', body: 'Confirm the transfer in your wallet…' });
      }

      const value = parseUnits(amount === '' ? '0' : amount, usdt.decimals);
      if (value === 0n) throw new Error('amount must be greater than zero');

      // 首次存入前：核對鏈上實際 enroll 的策略、版本、資產，並顯示給使用者（cre8-app#29 第 3 點）。
      //
      // 為什麼：第一次 enroll 仍然是平台的 operator 送的（之後的升版才由使用者自己簽）。
      // 在使用者把 USDT 轉進去之前，直接問 registry 這個帳戶被釘在哪個策略、哪一版、哪些資產：
      //   - 釘的不是這一檔（策略 id 不同，或配置不是這檔發布過的任何一版）→ **不轉錢**，講清楚。
      //   - 讀不到（舊合約、RPC 慢、enroll 那筆還沒被這個 RPC 看到）→ 不擋，照舊進行，只是沒有這段顯示。
      // 只在帳戶裡還沒有錢時做：之後每次存入都擋一次沒有意義，帳戶狀態在 My position 隨時看得到。
      let enrollmentLine: string | undefined;
      if (holding === undefined || totalUsd() === 0) {
        const verified = await verifyEnrollment(account as Address, portfolioIdAfterEnroll);
        if (verified.blocked !== null) {
          throw new Error(`${verified.blocked} Nothing was transferred. Contact support before you add money to this account.`);
        }
        enrollmentLine = verified.line ?? undefined;
        if (enrollmentLine !== undefined) {
          showProgress({ tone: 'pending', title: 'Checked your account on-chain', detail: enrollmentLine });
        }
      }

      // 動錢之前先確認這個帳戶的 gas 夠不夠；不夠就**自動補**。
      //
      // 為什麼：清倉時會把 BNB 掃回錢包（只留 0.003），下一次 deposit 之後再平衡就會碰到
      // 「USDT 進去了、但配置付不出 gas」—— 實測正是這樣：
      //   Send failed: Smart Account does not have sufficient funds
      // 與其讓它進半套，不如在轉 USDT 之前先把 gas 補到位。
      //
      // 只對**已存在的帳戶**：enroll 剛建好的新帳戶 gas 一定是 0，但那是「本來就該補」的情境，
      // 這裡也一併補（一次 top-up 同時覆蓋新帳戶與清倉後的舊帳戶）。
      if (account !== undefined && account !== null) {
        const gas = live?.gas;
        const balance = gas !== null && gas !== undefined && gas.balanceWei !== undefined ? BigInt(gas.balanceWei) : 0n;
        // 最低 gas：後端算的 `minimumWei`，或退而求其次用 0.0005 BNB（與後端
        // `DEFAULT_MIN_SESSION_GAS_WEI` 一致；新帳戶查不到 minimum 時走這個 fallback）。
        const minimum =
          gas !== null && gas !== undefined && gas.minimumWei !== undefined ? BigInt(gas.minimumWei) : parseEther('0.0005');
        if (balance < minimum) {
          // 補到 minimum + 一小段餘裕（約 1 筆交易的 gas），避免補完立刻又低於門檻。
          // 緩衝只留 0.0005 BNB（約 20 筆 UserOp）—— 原本是 0.01，等於每次補 5 倍的量。
          const topUpWei = minimum - balance + parseEther('0.0005');
          toast.replace(toastId, {
            tone: 'pending',
            title: 'Topping up gas',
            body: `Sending ${Number(formatEther(topUpWei)).toFixed(4)} BNB to the fund's account…`,
          });
          // 這是 owner 錢包 → 帳戶的普通 BNB 轉帳（會再要一次簽名）。
          showProgress({ tone: 'pending', title: 'Top up network gas', detail: 'Approve the BNB transfer in your wallet, then wait for it to confirm.' });
          await sendGasTopUp({ wallet, to: account as Address, valueWei: topUpWei });
          toast.replace(toastId, { tone: 'pending', title: 'Buy', body: 'Confirm the USDT transfer in your wallet…' });
        }
      }

      showProgress({ tone: 'pending', title: 'Approve the USDT transfer in your wallet', detail: enrollmentLine });
      const hash = await sendUsdt(wallet, usdt.address as Address, account as Address, value);
      transferHash = hash;
      const sent = `${formatUnits(value, usdt.decimals)} ${usdt.symbol}`;
      showProgress({ tone: 'pending', title: 'Transfer submitted', detail: `${sent} · Waiting for network confirmation.`, hash });
      toast.replace(toastId, { tone: 'pending', title: `Submitted ${sent}`, body: hash });
      setAmount('');

      // 等轉帳**真的被 RPC 看到**再觸發配置。
      //
      // 為什麼：使用者按 Deposit 之後我們立刻呼叫 rebalance，而後端用「目前區塊」讀餘額。
      // 有些 RPC 的 head 會落後一兩個塊（publicnode 實測），於是在 N-1 那個塊上帳戶還是 0 USDT
      // → 規劃器回『Portfolio value is 0 … not sending empty steps』→ 使用者看到
      // 「Deposit recorded (noop)」，錢明明進去了卻沒被配置。
      //
      // 等 2 個確認把「錢在鏈上」與「RPC 看得到它」之間的窗口關掉。
      transferState = await waitForConfirmations(wallet, hash, 2);
      if (transferState === 'reverted') {
        showProgress({ tone: 'error', title: 'Transfer reverted', detail: 'The network rejected the transfer.', hash });
        toast.replace(toastId, { tone: 'bad', title: 'Transfer reverted', body: hash });
        return;
      }
      showProgress({
        tone: 'pending', title: 'Preparing fund allocation', hash,
        detail: transferState === 'confirmed' ? `${sent} confirmed. Your wallet may ask for asset approvals.` : 'The transfer status is available on the block explorer.',
      });

      // 入金後**立刻**跑一輪配置。
      //
      // 為什麼一定要有這一步：排程器只認領 `next_run_at` 已到期的投組，而入金不會調整它 ——
      // 實測剛存完 100 USDT，下一輪是 **23 小時後**，畫面上 drift 9500 bps 卻什麼都不會發生。
      // 「錢進去了卻還是現金」是最容易被誤認為壞掉的行為。
      const target = portfolioIdAfterEnroll;
      if (target !== undefined && target !== null) {
        // ⚠ 一定要把回傳的 id 接住再 replace 它。
        //
        // pending 的 toast **不會自己消失**（那是刻意的：它要等結果）。如果結果用
        // `toast.ok(...)` 另開一則，那個「Configuring your deposit / Buying the target assets…」
        // 就會永遠留在畫面上轉 —— 實測就是這樣：綠色成功訊息淡出後，白色那則還在。
        const configuringId = toast.replace(toastId, {
          tone: 'pending',
          title: 'Allocating your purchase',
          body: 'Buying the target assets…',
        });
        // 先把 executor 授權好，否則第一輪一定被 ALLOWANCE_TOO_LOW 擋下（實測主網首次存款）。
        //
        // 這一步必須由**帳戶擁有者**簽名（approve 不在 session key 的 permit 清單裡，
        // 只有 executeRebalance 是），所以它只能發生在使用者在場的時候 —— 存款正好是那個時刻。
        // 一次 UserOp 打包所有 approve，不是每個資產一個簽名。
        const executorAddress = live?.executorAddress;
        // 只對「還沒授權」的資產送 approve。
        //
        // approve 給的是 max allowance，一次就永久有效 —— 第二次存款開始本來就不該再要簽名。
        // 這裡先讀鏈上 allowance（純讀取、不花錢、不簽名），把已授權過的濾掉。
        const universe = live?.drift.assets ?? [];
        const targets =
          executorAddress === null || executorAddress === undefined || universe.length === 0
            ? []
            : (await Promise.all(
                universe.map(async (row) => {
                  const allowance = await readOnlyClient()
                    .readContract({
                      address: row.asset as Address,
                      abi: ERC20_ABI,
                      functionName: 'allowance',
                      args: [account as Address, executorAddress as Address],
                    })
                    // 讀不到就當沒授權：寧可多簽一次，也不要送出一筆必定 revert 的 rebalance。
                    .catch(() => 0n);
                  return { row, approved: allowance > 0n };
                }),
              ))
                .filter((entry) => !entry.approved)
                .map((entry) => entry.row);

        if (executorAddress !== null && executorAddress !== undefined && targets.length > 0) {
          try {
            toast.replace(configuringId, {
              tone: 'pending',
              title: 'Approving the executor',
              body: `One signature for ${targets.length} asset${targets.length === 1 ? '' : 's'}…`,
            });
            await sendSudoCalls({
              wallet,
              token,
              accountAddress: account as Address,
              strategyId: holding?.strategyId ?? strategy.id,
              calls: targets.map((row) => ({
                to: row.asset as Address,
                data: approveCalldata(executorAddress as Address),
                value: 0n,
              })),
            });
            toast.replace(configuringId, {
              tone: 'pending',
              title: 'Allocating your purchase',
              body: 'Buying the target assets…',
            });
          } catch (cause) {
            // 授權失敗不擋存款本身：錢已經到了，使用者可以再按一次。
            toast.replace(configuringId, {
              tone: 'warn',
              title: 'Asset approval failed',
              body: (cause as Error).message.split('\n')[0].slice(0, 140),
            });
            throw cause;
          }
        }

        try {
          const round = await postRebalance(token, target);
          if (round.outcome === 'executed') recordTrades('deposit', round.steps);
          // 三種結果要講清楚，因為它們要求使用者做的事完全不同：
          //   executed → 配置完成
          //   blocked  → 被前置檢查擋下（最常見是 allowance），要**再按一次**或先 approve
          //   noop     → 規劃器認為沒事可做（錢沒被看到/已經對齊）
          // A10：被平台全域暫停、帳戶暫停或買入額度擋下時，直接說是哪一種（錢已經在帳戶裡，仍是 USDT）。
          const a10Reason = round.outcome === 'executed' ? null
            : explainA10Failure(round.reason ?? '', { pauseSources, nextBuyAt: buyLimit?.nextBuyAt ?? null });
          allocation = round.outcome === 'executed' ? 'Initial allocation executed.' :
            a10Reason !== null ? `Your USDT arrived and is waiting in your account. ${a10Reason}` :
            round.outcome === 'blocked' ? 'Initial allocation was blocked. Check Portfolio for the latest status.' :
              'No initial allocation was executed. Check Portfolio for the latest status.';
          const tone = round.outcome === 'executed' ? 'ok' : round.outcome === 'blocked' ? 'bad' : 'warn';
          const title =
            round.outcome === 'executed'
              ? 'Purchase allocated'
              : round.outcome === 'blocked'
                ? 'Initial allocation was blocked'
                : `No initial allocation (${round.outcome})`;
          toast.replace(configuringId, {
            tone,
            title,
            body: round.txHash ?? a10Reason ?? round.reason ?? undefined,
          });
        } catch (cause) {
          // 配置失敗不影響入金；收據獨立顯示這兩個狀態。
          allocation = 'Initial allocation did not complete. Check Portfolio for the latest status.';
          toast.replace(configuringId, {
            tone: 'warn',
            title: 'Initial allocation did not complete',
            body: (cause as Error).message.split('\n')[0].slice(0, 140),
          });
        }
      }
      // 存款後要重抓的是**整條依賴鏈**，不是只有 portfolios：
      //
      //   strategies ──┐
      //                ├──> holding ──> held ──> 「My position」按鈕出不出現
      //   portfolios ──┘
      //
      // 只失效 portfolios 的話，`strategy` 可能還是快取裡那個「這檔基金還沒上鏈」的舊清單，
      // 於是 `holding` 永遠找不到 → 按鈕不出現，**要手動重整才會出現**（實測回報）。
      //
      // `refetchType: 'all'` 連非 active 的查詢一起重抓：`fund-status` 的 queryKey 帶
      // `holding?.id`，在剛 enroll 完的那一輪 render 裡它是 `undefined` 且 `enabled: false` ——
      // 預設只重抓 active 查詢的話，那一筆會被跳過。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategies'], refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' }),
      ]);
      showProgress({
        tone: transferState === 'confirmed' ? 'confirmed' : 'notice',
        title: transferState === 'confirmed' ? 'Purchase confirmed' : 'Transfer submitted',
        amount: sent,
        detail: transferState === 'confirmed' ? allocation : 'Check the block explorer for confirmation.',
        hash,
      });
    } catch (cause) {
      showProgress(transferHash ? {
        tone: 'notice',
        title: transferState === 'confirmed' ? 'Purchase received' : 'Transfer submitted',
        detail: transferState === 'confirmed' ? 'Initial allocation did not complete. Check your portfolio.' : 'Check the block explorer for confirmation.',
        hash: transferHash,
      } : { tone: 'error', title: 'Purchase not sent', detail: friendlyFailure(String((cause as Error).message ?? cause)).split('\n')[0].slice(0, 200) });
      setError(cause);
      toast.replace(toastId, transferHash ? {
        tone: 'warn', title: transferState === 'confirmed' ? 'Purchase received; check allocation' : 'Check transfer status', body: transferHash,
      } : { tone: 'bad', title: 'Purchase failed', body: friendlyFailure((cause as Error).message).split('\n')[0].slice(0, 180) });
      // 轉帳已經送出的話，錢可能已經到帳（只是後面的配置沒完成）：讓 Sell 面板的現金與總值跟上。
      if (transferHash) void queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' });
    } finally {
      setBusy(false);
    }
  }

  /** 帳戶的 BNB 是否低於可執行門檻（5e14 wei = 0.0005 BNB，與後端 `DEFAULT_MIN_SESSION_GAS_WEI` 一致）。 */
  function gasTooLow(status: PortfolioStatus): boolean {
    if (status.gas === null) return true;
    const wei = status.gas.balanceWei;
    if (wei === null || wei === undefined) return true;
    return BigInt(wei) < 5n * 10n ** 14n;
  }


  /** 帳戶裡的現金（numeraire）價值（美元）。 */
  function cashUsd(): number {
    const row = (live?.holdings ?? []).find((entry) => entry.symbol === (usdt?.symbol ?? 'USDT'));
    return row === undefined ? 0 : Number(row.usdValueE8) / 1e8;
  }

  /**
   * Deposit 的 Max = 錢包 USDT 餘額**向下取整到分**。
   *
   * 寫死 `1000` 的快捷鍵在餘額只有 996 時會直接把表單填成一個「必定 revert」的金額
   * （實測使用者按下去只看到 "That is more than the wallet holds"）。最大值只能向下取。
   */
  function maxDepositLabel(): string {
    if (walletUsdt === null) return '';
    const amount = Number(formatUnits(walletUsdt, usdtDecimals));
    return amount === 0 ? '' : (Math.floor(amount * 100) / 100).toFixed(2);
  }

  /** 整個基金價值（美元）。 */
  function totalUsd(): number {
    return live === undefined || live.totalUsdE8 === null ? 0 : Number(live.totalUsdE8) / 1e8;
  }

  function maxWithdrawLabel(): string {
    return totalUsd() === 0 ? '' : totalUsd().toFixed(2);
  }

  /**
   * 清倉：① 全部賣成 USDT（session key）② 把 USDT 與**所有殘留代幣**掃回錢包（owner 簽）。
   *
   * 為什麼要第二段掃塵埃：賣出有滑價與 wei 級取整，帳戶裡一定會剩一點非 USDT 的渣。
   * 「清倉」的語意是錢包裡什麼都不剩，不是帳戶裡什麼都不剩。
   */
  /**
   * 只授權「還沒授權」的資產。這顆按鈕存在的理由：
   *
   * `ALLOWANCE_TOO_LOW` 是後端送交易前才發現的，使用者看到的是英文錯誤訊息。
   * 把「你有錢、但 executor 還不能動它」變成畫面上一個明確的狀態 + 一顆按鈕，
   * 他就不必讀懂 allowance 這個字。
   */
  async function approveMissingAssets(): Promise<void> {
    if (wallet === null || token === null || holding === undefined || live === undefined) return;
    const executorAddress = live.executorAddress;
    const accountAddress = live.account;
    if (executorAddress === null || executorAddress === undefined) {
      throw new Error('this deployment has no executor configured');
    }
    const pending = live.drift.assets.filter((row) => unapproved?.includes(row.symbol) === true);
    if (pending.length === 0) return;

    setApproving(true);
    setError(null);
    const id = toast.pending(
      'Approving the executor',
      `One signature for ${pending.length} asset${pending.length === 1 ? '' : 's'}…`,
    );
    try {
      await sendSudoCalls({
        wallet,
        token,
        accountAddress: accountAddress as Address,
        strategyId: holding.strategyId,
        calls: pending.map((row) => ({
          to: row.asset as Address,
          data: approveCalldata(executorAddress as Address),
          value: 0n,
        })),
      });
      toast.replace(id, {
        tone: 'ok',
        title: 'Executor approved',
        body: 'The next rebalance can pull these assets.',
      });
      setUnapproved(null);
      await queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' });
    } catch (cause) {
      toast.replace(id, {
        tone: 'bad',
        title: 'Approval failed',
        body: (cause as Error).message.split('\n')[0].slice(0, 140),
      });
      setError(cause);
    } finally {
      setApproving(false);
    }
  }

  /**
   * 續期交易權限（cre8-app#25）：owner 簽一筆 sudo UserOp，在帳戶上安裝後端派生好的新 session key，
   * 成功後回報後端記錄。到期前、或後端換了 master seed 之後都走這一條。
   *
   * 三步都用既有的東西：`GET renewal-params` → `sendRenewalUserOp` → `POST renewal-result`。
   * 這裡只是把入口接回來（原本在 `/portfolios/:id` 頁，那一頁移除後就沒有地方按了）。
   */
  async function renewPermission(): Promise<void> {
    if (wallet === null || token === null || holding === undefined) return;
    setRenewing(true);
    setError(null);
    setRenewNote(null);
    const id = toast.pending('Renewing trading permission', 'Preparing the new permission…');
    try {
      const params = await getRenewalParams(token, holding.id);
      if (params.ownerAddress.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error('This account belongs to a different wallet. Connect the wallet that created it and try again.');
      }
      toast.replace(id, { tone: 'pending', title: 'Renewing trading permission', body: 'Confirm it in your wallet…' });
      const receipt = await sendRenewalUserOp({
        wallet,
        token,
        accountAddress: params.accountAddress as Address,
        entryPoint: params.entryPoint,
        initConfig: params.initConfig as `0x${string}`[],
        strategyId: params.strategyId,
      });
      if (!receipt.success) throw new Error(`The renewal landed on-chain but reverted: ${receipt.txHash}`);
      // 鏈上已經裝好了；回報只是讓後端知道有這一把。回報失敗就多試兩次 ——
      // 這時再按一次 Renew 會多裝一把新的，不是使用者想要的。
      let recorded = false;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3 && !recorded; attempt += 1) {
        try {
          await postRenewalResult(token, holding.id, {
            keyRef: params.keyRef,
            permissionId: params.permissionId,
            validUntil: params.validUntil,
            policySnapshot: params.policySnapshot,
          });
          recorded = true;
        } catch (cause) {
          lastError = cause;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      if (!recorded) {
        throw new Error(
          `The new permission is installed on-chain (${receipt.txHash}), but the server did not record it: ` +
            `${String((lastError as Error)?.message ?? lastError).split('\n')[0].slice(0, 120)}`,
        );
      }
      setRenewNote(renewedMessage(params.validUntil));
      toast.replace(id, { tone: 'ok', title: 'Trading permission renewed', body: receipt.txHash });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' }),
      ]);
    } catch (cause) {
      toast.replace(id, {
        tone: 'bad',
        title: 'Renewal not completed',
        body: (cause as Error).message.split('\n')[0].slice(0, 140),
      });
      setError(cause);
    } finally {
      setRenewing(false);
    }
  }

  /** 幫帳戶補 gas（owner 錢包轉 BNB 進帳戶，與 portfolio 頁的 top-up 同一條路徑）。 */
  async function topUpGas(): Promise<void> {
    if (wallet === null || token === null || holding === undefined) return;
    const account = holding.smartAccounts[0]?.address;
    if (account === undefined) return;
    setToppingUp(true);
    setError(null);
    try {
      await sendGasTopUp({ wallet, to: account as Address, valueWei: parseEther('0.0005') });
      await queryClient.invalidateQueries({ queryKey: ['fund-status', token, holding.id] });
    } catch (cause) {
      setError(cause);
    } finally {
      setToppingUp(false);
    }
  }

  /**
   * `skipSell`：不賣，直接把帳戶裡的代幣原樣掃回錢包（owner 簽，不經過 executor）。
   * 平台全域暫停或帳戶被暫停時，賣出一定被合約擋下；這是那時候把資產領出來的路（cre8-app#29）。
   */
  async function closeAll(options: { skipSell?: boolean } = {}): Promise<void> {
    if (wallet === null || token === null || holding === undefined) return;
    const account = holding.smartAccounts[0]?.address;
    if (account === undefined) throw new Error('找不到帳戶');
    setClosing(true);
    setWithdrawError(null);
    setWithdrawTx(null);
    setWithdrawNote(null);
    setRoutes(null);
    const toastId = toast.pending('Closing position', 'Checking what is left to sell…');
    try {
      // 先看帳戶裡還有沒有值得賣的部位（cre8-app#23）。
      // 沒有 → 跳過賣出直接掃。這是「上一次賣完了、掃回那一步失敗」的重試路徑：
      // 那時投組已經 paused，後端的 `/close` 會拒絕，但也沒有東西要它賣了。
      const cashSymbol = usdt?.symbol ?? 'USDT';
      const before = await getPortfolioStatus(token, holding.id);
      let soldSteps = 0;
      if (options.skipSell !== true && hasSellablePositions(before.holdings ?? [], cashSymbol)) {
        toast.replace(toastId, { tone: 'pending', title: 'Closing position', body: 'Selling every position to USDT…' });
        // 大部位會被後端切成好幾批（每個資產有單筆上限，cre8-app#39）：一直叫 `/close` 到賣完為止。
        // 每一次呼叫都等那一批確認才回來。清倉的續做不用帶剩餘量 —— `/close` 永遠是「賣掉剩下的全部」。
        const close = () => recordSale(closePosition(token, holding.id));
        let run;
        try {
          run = await runSellBatches({
            first: close,
            next: close,
            onContinue: ({ batch, remainingUsdE8 }) =>
              toast.replace(toastId, {
                tone: 'pending',
                title: 'Selling in batches',
                body: `Batch ${batch} — about ${formatRemainingUsd(remainingUsdE8)} left to sell…`,
              }),
          });
        } catch (cause) {
          if (!(cause instanceof SellBatchError)) throw cause;
          throw new Error(
            cause.completedBatches === 0
              ? `closing the position failed: ${cause.message}`
              : `closing the position stopped after ${cause.completedBatches} batch${cause.completedBatches === 1 ? '' : 'es'}: ${cause.message}. ` +
                  'What was sold is safe in the fund account as USDT — press Close position again to continue.',
          );
        }
        const after = afterSellRun(run);
        // 到批數上限還沒賣完：不掃。現在掃會把還沒賣的部位當成代幣原樣送回錢包，不是使用者要的「清倉」。
        if (after === 'press-again' && run.remainingUsdE8 !== null) {
          throw new SellUnfinished(
            `Sold in ${run.batches} batches so far; about ${formatRemainingUsd(run.remainingUsdE8)} is still to be sold. ` +
              'Press Close position again to continue.',
          );
        }
        // 後端沒說還剩多少（`remainingUsdE8: null`）：不能當成賣完。不掃，顯示原因，請使用者再按一次。
        if (after === 'unknown') {
          throw new Error(
            `closing the position stopped: the fund could not work out how much is left to sell (${run.lastReason}). ` +
              'Nothing was sent to your wallet — press Close position again.',
          );
        }
        // 剩下的確定賣不動（單筆上限為 0、流動性不足、渣）→ 照舊往下，當代幣掃回錢包。
        soldSteps = run.steps;
      }
      // 賣完重讀：USDT + 所有非零餘額（含賣不掉的塵埃）一起掃回去。
      // 清單（有哪些代幣）問後端；每一個的數量**再直接問鏈一次，取兩邊較小的那個**。
      // 兩個來源各自可能落後一兩個塊：拿到賣出前的數量去轉就會超過餘額而 revert。
      // 取較小值代表只要有一邊是新的就不會超轉；最壞情況是少掃一點，再按一次 Close 就清掉。
      const fresh = soldSteps === 0 ? before : await getPortfolioStatus(token, holding.id);
      const reader = publicClientFor(wallet);
      const balances = await Promise.all(
        (fresh.holdings ?? []).map(async (row) => {
          const asset = row.asset as Address;
          const reported = BigInt(row.amountWei);
          try {
            const onChain = await reader.readContract({ address: asset, abi: ERC20_ABI, functionName: 'balanceOf', args: [account as Address] });
            return { asset, amountWei: lowerOf(onChain as bigint, reported) };
          } catch {
            return { asset, amountWei: reported };
          }
        }),
      );
      // 連 gas 一起：清倉的語意是「這個帳戶什麼都不剩」。
      // 必須留一點付**這一筆** UserOp 的 gas，否則連驗證都過不了（AA21/AA51）。
      //
      // BNB 餘額要用**賣完之後**的：賣出那幾筆 UserOp 是帳戶自己付 gas。原本用的是頁面上
      // 那份舊的 `live.gas.balanceWei`（實測 0.0311636，鏈上只剩 0.0013423），
      // 掃出去的金額比餘額多，整筆 sweep 在模擬時 revert。
      const reportedGas = fresh.gas?.balanceWei;
      let gasBalanceWei = reportedGas === null || reportedGas === undefined ? null : BigInt(reportedGas);
      try {
        const onChain = await reader.getBalance({ address: account as Address });
        gasBalanceWei = gasBalanceWei === null ? onChain : lowerOf(onChain, gasBalanceWei);
      } catch {
        // 讀鏈失敗 → 用後端剛回的數字；兩邊都沒有就不掃 BNB。
      }
      const nativeWei = sweepNativeWei(gasBalanceWei ?? 0n);
      const receipt = await sendSweep({
        wallet,
        token,
        accountAddress: account as Address,
        strategyId: holding.strategyId,
        recipient: wallet.address as Address,
        balances,
        nativeWei,
      });
      toast.replace(toastId, { tone: 'pending', title: 'Sending everything back', body: 'Confirm the transfer in your wallet…' });
      if (receipt === null) {
        setWithdrawNote('Nothing left to send back — the account is already empty.');
      } else if (!receipt.success) {
        throw new Error(`sweep UserOp landed but reverted: ${receipt.txHash}`);
      } else {
        setWithdrawTx(receipt.txHash);
        setWithdrawNote(
          soldSteps === 0
            ? `${options.skipSell === true ? 'Sent without selling' : 'Nothing left to sell'} — ${balances.filter((row) => row.amountWei > 0n).length} token(s) sent back to your wallet.`
            : `Closed: ${soldSteps} sell step(s), then ${balances.filter((row) => row.amountWei > 0n).length} token(s) sent back to your wallet.`,
        );
      }
      // 存款後要重抓的是**整條依賴鏈**，不是只有 portfolios：
      //
      //   strategies ──┐
      //                ├──> holding ──> held ──> 「My position」按鈕出不出現
      //   portfolios ──┘
      //
      // 只失效 portfolios 的話，`strategy` 可能還是快取裡那個「這檔基金還沒上鏈」的舊清單，
      // 於是 `holding` 永遠找不到 → 按鈕不出現，**要手動重整才會出現**（實測回報）。
      //
      // `refetchType: 'all'` 連非 active 的查詢一起重抓：`fund-status` 的 queryKey 帶
      // `holding?.id`，在剛 enroll 完的那一輪 render 裡它是 `undefined` 且 `enabled: false` ——
      // 預設只重抓 active 查詢的話，那一筆會被跳過。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategies'], refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' }),
      ]);
      toast.replace(toastId, { tone: 'ok', title: 'Position closed', body: 'Every asset is back in your wallet.' });
    } catch (cause) {
      // 到批數上限、還沒賣完：這不是錯誤，是「再按一次繼續」。顯示成提示，並重讀狀態讓數字跟上。
      if (cause instanceof SellUnfinished) {
        setWithdrawNote(cause.message);
        toast.replace(toastId, { tone: 'warn', title: 'More to sell', body: cause.message });
        await queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' });
        return;
      }
      const raw = String((cause as Error).message ?? cause);
      const friendly = explainA10Failure(raw, { pauseSources, nextBuyAt: buyLimit?.nextBuyAt ?? null });
      setWithdrawError(friendly === null ? cause : new Error(friendly));
      if (isPermissionFailure(raw)) setWithdrawNote(PERMISSION_HINT);
      toast.replace(toastId, { tone: 'bad', title: 'Close failed', body: (friendly ?? raw).split('\n')[0].slice(0, 180) });
      // 失敗前可能已經賣掉一部分：讓面板上的數字跟上。
      void queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' });
    } finally {
      setClosing(false);
    }
  }

  /**
   * 帳戶此刻在鏈上的 USDT 餘額（wei）。提領最後一步的轉帳上限就是它。
   *
   * 先直接問鏈（`balanceOf`）；RPC 讀不到時退回後端 status 的 `amountWei`（一樣是 wei 字串，
   * 不是美元價值）。兩條路都不經過浮點數。
   */
  async function readAccountUsdtWei(account: Address, asset: Address): Promise<bigint> {
    if (wallet !== null) {
      try {
        const balance = await publicClientFor(wallet).readContract({
          address: asset,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [account],
        });
        return balance as bigint;
      } catch {
        // 讀鏈失敗 → 用後端剛讀到的餘額。
      }
    }
    if (token === null || holding === undefined) return 0n;
    const fresh = await getPortfolioStatus(token, holding.id);
    const row = (fresh.holdings ?? []).find((entry) => entry.asset.toLowerCase() === asset.toLowerCase());
    return row === undefined ? 0n : BigInt(row.amountWei);
  }

  async function withdraw(): Promise<void> {
    if (wallet === null || token === null || holding === undefined || live === undefined) return;
    const account = holding.smartAccounts[0]?.address;
    const requested = Number(withdrawAmount === '' ? '0' : withdrawAmount);
    const cashSymbol = usdt?.symbol ?? 'USDT';
    const usdtAsset = usdt?.address;
    setWithdrawBusy(true);
    setWithdrawError(null);
    setWithdrawTx(null);
    setWithdrawNote(null);
    setRoutes(null);
    const toastId = toast.pending('Sell', 'Preparing…');
    if (mobile) ticketToast.current = toastId;
    showProgress({ tone: 'pending', title: 'Preparing your sale', detail: 'Checking the fund’s available USDT.' });
    try {
      // 錢包不在本 app 的鏈上時，簽名請求會「看起來沒反應」（其實是被鏈切換擋掉）。
      // 明講要切到哪一條，比讓使用者一直按卻沒有彈窗好。
      if (wallet.kind === 'injected') {
        const raw = await (wallet.provider as { request: (a: { method: string }) => Promise<unknown> })
          .request({ method: 'eth_chainId' })
          .catch(() => null);
        const walletChain = typeof raw === 'string' ? Number.parseInt(raw, 16) : null;
        if (walletChain !== null && walletChain !== CHAIN_ID) {
          throw new Error(
            `Your wallet is on chain ${walletChain}; this app needs chain ${CHAIN_ID}. ` +
              `Switch MetaMask to the network that uses RPC http://127.0.0.1:8545 with chain id ${CHAIN_ID}.`,
          );
        }
      }
      if (account === undefined || usdtAsset === undefined) throw new Error('找不到帳戶或會計資產');
      if (!Number.isFinite(requested) || requested <= 0) throw new Error('amount must be greater than zero');
      // 送出前**重讀一次** status，現金與總值都用這一份（cre8-app#49）。
      //
      // 原本用的是頁面上快取的 `live`。頁面資料舊的時候（剛存款、排程器在背景又買了幾批），
      // 會以為現金夠而完全不賣出，只把帳戶裡實際有的 USDT 轉出，還說成「沒有可賣的部位」
      // （實測：要提 250，頁面以為現金 400，實際只有 39.66 與 $356 的 DOGE；redeem 一次都沒被呼叫）。
      // 讀不到就停下：拿舊資料決定要不要賣，正是這個 bug。
      let latest: PortfolioStatus;
      try {
        latest = await getPortfolioStatus(token, holding.id);
      } catch (cause) {
        throw new Error(`could not read the fund's current balances, so nothing was sold or sent: ${(cause as Error).message}`);
      }
      // 順便讓頁面上的 Cash／positions／total 跟上剛讀到的數字。
      queryClient.setQueryData(['fund-status', token, holding.id], latest);
      const cash = cashUsdOf(latest.holdings ?? [], cashSymbol);
      const usdtRow = (latest.holdings ?? []).find((entry) => entry.symbol === cashSymbol);
      // ⚠ 不因為「超過總值」丟錯，而是**夾到可提領上限**。
      // 這裡本來是 `throw`，結果 Max 按鈕只要因為四捨五入多填 0.01，使用者就完全無法提領
      // （實測：total 996.0999 → Max 填 996.10 → 直接被自己的驗證擋掉）。
      // 提領自己的錢，多填一點的正確反應是「提出全部」，不是報錯。
      const ceiling = totalUsdOf(latest.totalUsdE8);
      const effective = Math.min(requested, ceiling);
      if (requested > ceiling + 1e-6) {
        setWithdrawNote(`Capped to the fund value: ${formatUsd(ceiling)} (you asked for ${formatUsd(requested)}).`);
      }

      // 現金不夠 → 先按比例賣（session key 簽），再轉出（owner 簽）。
      //
      // 賣出量要**放大**：賣掉 $X 的部位不會換到 $X 的 USDT —— 每一條腿都有成本
      // （池費 0.25%、TWAP 地板折扣、價格衝擊）。實測 4 檔賣 $350 只換回 $332（少 5.2%），
      // 於是「提領 400」實際只拿到 381.76。按缺口賣等於系統性少給。
      //
      // 所以：① 按 1/(1−緩衝) 放大 ② 賣完重讀餘額 ③ 還是不夠就再補一輪（最多 2 輪）。
      // 上限 2 輪是刻意的：真的賣不動（流動性不足）時，重試只會燒 gas 而不會變好。
      // （放大比例 `SELL_BUFFER` 與缺口的算法在 lib/withdraw-plan.ts。）
      const MAX_SELL_ROUNDS = 2;
      const readCash = async (): Promise<number> => {
        latest = await getPortfolioStatus(token, holding.id);
        return cashUsdOf(latest.holdings ?? [], cashSymbol);
      };
      /** 最後一批賣出時後端說的話；轉出的比要求的少時拿來說明原因。 */
      let lastSellReason: string | null = null;

      // 分批（cre8-app#39）：每個資產有單筆交易上限，後端一次只賣一批並回報還剩多少（`remainingUsdE8`）。
      // 所以「一輪」不再是一次呼叫，而是「首批送 usd，之後把剩餘量帶回去續做，直到 0」。
      // 整次點擊最多 `MAX_SELL_BATCHES` 批；到了還沒賣完就停下來，**不轉出**，請使用者再按一次 ——
      // 已經賣到的 USDT 留在帳戶裡當現金，下一次按的時候缺口自然變小，就是從剩下的部分接續。
      let available = cash;
      let batchesLeft = MAX_SELL_BATCHES;
      for (let round = 1; round <= MAX_SELL_ROUNDS; round += 1) {
        const target = sellTargetUsd(effective, available);
        if (target === null || batchesLeft <= 0) break;
        showProgress({ tone: 'pending', title: 'Selling positions', detail: 'Raising USDT for your sale.' });
        toast.replace(toastId, { tone: 'pending', title: 'Selling positions', body: `Round ${round}: raising ${formatUsd(target)}…` });
        let run;
        try {
          run = await runSellBatches({
            first: () => recordSale(redeemPortfolio(token, holding.id, target)),
            next: (remainingUsdE8) => recordSale(continueRedeem(token, holding.id, remainingUsdE8)),
            maxBatches: batchesLeft,
            onContinue: ({ batch, remainingUsdE8 }) => {
              const detail = `Batch ${batch} — about ${formatRemainingUsd(remainingUsdE8)} left to sell.`;
              showProgress({ tone: 'pending', title: 'Selling in batches', detail });
              toast.replace(toastId, { tone: 'pending', title: 'Selling in batches', body: detail });
            },
          });
        } catch (cause) {
          if (!(cause instanceof SellBatchError)) throw cause;
          throw new Error(
            cause.completedBatches === 0
              ? `selling the shortfall failed: ${cause.message}`
              : `selling stopped after ${cause.completedBatches} batch${cause.completedBatches === 1 ? '' : 'es'}: ${cause.message}. ` +
                  'What was sold is in the fund account as USDT — press Sell again to continue.',
          );
        }
        batchesLeft -= run.batches;
        const after = afterSellRun(run);
        if (after === 'press-again' && run.remainingUsdE8 !== null) {
          throw new SellUnfinished(
            `Sold in ${MAX_SELL_BATCHES - batchesLeft} batches so far; about ${formatRemainingUsd(run.remainingUsdE8)} is still to be sold. ` +
              'The USDT raised so far is waiting in the fund account — press Sell again to continue.',
          );
        }
        // 後端沒說還剩多少（`remainingUsdE8: null`）：不能當成賣完，也不能說成「沒有部位可賣了」。
        // 不轉出，顯示原因，請使用者再按一次。
        if (after === 'unknown') {
          throw new Error(
            `selling stopped: the fund could not work out how much is left to sell (${run.lastReason}). ` +
              'Nothing was transferred — press Sell again.',
          );
        }
        available = await readCash();
        // 剩下的確定賣不動（沒有可賣的部位、單筆上限擋住）→ 再試也是一樣，直接停，
        // 往下把已經有的 USDT 轉出並說明少了多少。
        if (run.status === 'stalled' || run.steps === 0) {
          lastSellReason = run.lastReason;
          break;
        }
      }

      // 轉出的金額全程走 BigInt，並以帳戶**鏈上的 USDT 餘額（wei）**為上限（cre8-app#18）。
      //
      // 原本是 `parseUnits(sendable.toFixed(6))`：`sendable` 來自 `usdValueE8`（美元價值，不是代幣數量），
      // 而 `toFixed` 會四捨五入進位 —— 實測餘額 49.763435678… 被寫成 49.763436，比帳戶多，
      // UserOp 在模擬時就 revert（`BEP20: transfer amount exceeds balance`）。
      // 上面賣出迴圈裡的 `available`（美元）只用來決定「還要不要再賣一輪」，不再拿來算轉帳金額。
      const decimals = usdtRow?.decimals ?? usdtDecimals;
      const balanceWei = await readAccountUsdtWei(account as Address, usdtAsset as Address);
      // 使用者輸入的字串直接換成 wei（多的小數截掉）；只有被夾到基金總值時才用那個數字。
      // （輸入若不是單純的十進位數字，例如 `1e2`，也改用已經驗過的數值。）
      const plain = /^\d*\.?\d*$/.test(withdrawAmount.trim());
      const wanted = requested > ceiling + 1e-6 || !plain ? effective.toFixed(8) : withdrawAmount;
      const value = withdrawAmountWei(wanted, balanceWei, decimals);
      if (value === 0n) throw new Error('there is nothing to send after selling');
      const sendable = Number(formatUnits(value, decimals));
      showProgress({ tone: 'pending', title: 'Approve the sale in your wallet' });
      const receipt = await sendWithdraw({
        wallet,
        token,
        accountAddress: account as Address,
        strategyId: holding.strategyId,
        asset: usdtAsset as Address,
        recipient: wallet.address as Address,
        amountWei: value,
      });
      if (!receipt.success) throw new Error(`UserOp landed but reverted: ${receipt.txHash}`);
      // 轉出的比要求的少：只有最新的 status 真的沒有部位時才說「沒有部位可賣」，
      // 其餘情況說的是「這次賣不動」與原因（cre8-app#49）。
      setWithdrawNote(withdrawShortfallNote({
        sentUsd: sendable,
        askedUsd: effective,
        holdings: latest.holdings ?? [],
        cashSymbol,
        reason: lastSellReason,
      }));
      setWithdrawTx(receipt.txHash);
      showProgress({
        tone: 'confirmed', title: 'Sale confirmed', hash: receipt.txHash,
        amount: `${formatUnits(value, decimals)} USDT`,
        detail: sendable < effective - 0.01 ? 'Less USDT was available than requested.' : undefined,
      });
      toast.replace(toastId, { tone: 'ok', title: `Withdrew ${formatUsd(sendable)}`, body: receipt.txHash });
      // 存款後要重抓的是**整條依賴鏈**，不是只有 portfolios：
      //
      //   strategies ──┐
      //                ├──> holding ──> held ──> 「My position」按鈕出不出現
      //   portfolios ──┘
      //
      // 只失效 portfolios 的話，`strategy` 可能還是快取裡那個「這檔基金還沒上鏈」的舊清單，
      // 於是 `holding` 永遠找不到 → 按鈕不出現，**要手動重整才會出現**（實測回報）。
      //
      // `refetchType: 'all'` 連非 active 的查詢一起重抓：`fund-status` 的 queryKey 帶
      // `holding?.id`，在剛 enroll 完的那一輪 render 裡它是 `undefined` 且 `enabled: false` ——
      // 預設只重抓 active 查詢的話，那一筆會被跳過。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategies'], refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
        queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' }),
      ]);
    } catch (cause) {
      if (cause instanceof SellUnfinished) {
        setWithdrawNote(cause.message);
        showProgress({ tone: 'notice', title: 'More to sell', detail: cause.message });
        toast.replace(toastId, { tone: 'warn', title: 'More to sell', body: cause.message });
        await queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' });
        return;
      }
      const rawDetail = String((cause as Error).message ?? cause);
      const friendlyDetail = explainA10Failure(rawDetail, { pauseSources, nextBuyAt: buyLimit?.nextBuyAt ?? null });
      const detail = (friendlyDetail ?? rawDetail).split('\n')[0].slice(0, 200);
      setWithdrawError(friendlyDetail === null ? cause : new Error(friendlyDetail));
      if (isPermissionFailure(String((cause as Error).message ?? cause))) setWithdrawNote(PERMISSION_HINT);
      showProgress({ tone: 'error', title: 'Sale not completed', detail });
      toast.replace(toastId, { tone: 'bad', title: 'Sale not completed', body: detail });
      // 失敗前可能已經賣掉一部分（現金變多、部位變少）：讓面板上的數字跟上，不要停在舊的。
      void queryClient.invalidateQueries({ queryKey: ['fund-status'], refetchType: 'all' });
    } finally {
      setWithdrawBusy(false);
    }
    }
}

/** 用 owner 錢包把 USDT 轉進 Kernel 帳戶（dev 私鑰或注入錢包都支援）。 */
/**
 * 等交易被 **N 個確認**（預設 2）—— 不是只等 receipt。
 *
 * 只等 receipt 的話，我們拿到的「已上鏈」與「RPC 的 head 已經超過那一塊」是兩件事：
 * 後端用 head 讀餘額，head 落後時就看不到剛進來的錢（實測造成 deposit 後的 noop）。
 * 多等一個確認等於替 RPC 留一個塊的追上時間。
 *
 * 使用與送出交易相同的網路讀取收據；這一步不會要求錢包簽名。
 */
async function waitForConfirmations(
  wallet: NonNullable<ReturnType<typeof useOwnerWallet>>,
  hash: string,
  confirmations = 2,
): Promise<'submitted' | 'confirmed' | 'reverted'> {
  try {
    const receipt = await publicClientFor(wallet).waitForTransactionReceipt({
      hash: hash as `0x${string}`, confirmations, timeout: 15_000,
    });
    return receipt.status === 'success' ? 'confirmed' : 'reverted';
  } catch {
    return 'submitted';
  }
}

async function sendUsdt(
  wallet: NonNullable<ReturnType<typeof useOwnerWallet>>,
  token: Address,
  to: Address,
  value: bigint,
): Promise<string> {
  const { createWalletClient, custom, http } = await import('viem');
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, value] });

  if (wallet.kind === 'dev') {
    const rpcUrl = import.meta.env.VITE_RPC_URL ?? (import.meta.env.DEV ? '/rpc' : undefined);
    if (rpcUrl === undefined || rpcUrl === '') throw new Error('dev mode needs VITE_RPC_URL');
    const client = createWalletClient({ account: wallet.account, chain: appChain, transport: http(rpcUrl) });
    return client.sendTransaction({ to: token, data, chain: appChain });
  }
  const client = createWalletClient({ account: wallet.address, chain: appChain, transport: custom(wallet.provider as never) });
  return client.sendTransaction({ to: token, data, chain: appChain });
}

// AssetLogo 目前沒用到（表格用符號），保留 import 會讓 typecheck 失敗，所以標記為已使用。
void AssetLogo;
void Spinner;

/** 桌面版：whitelist-only 的基金按下送出後，在按鈕下方說明。手機版改用 TicketReceipt 顯示同一段文字。 */
function WhitelistNote({ action }: { action: TicketAction }): ReactNode {
  return (
    <div className="app-whitelist-note" role="status">
      <strong>{WHITELIST_COPY.title}</strong>
      <p>{WHITELIST_COPY[action]}</p>
    </div>
  );
}
