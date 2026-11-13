import { expect, test } from "bun:test";
import { PLATFORM_PAUSED_MESSAGE, explainA10Failure } from "../src/lib/a10";
import { TRADE_NOT_SENT_MESSAGE, TradeFailureError, explainTradeFailure, type TradeFailureKind } from "../src/lib/trade-failure";

// cre8-app#55：後端 `/rebalance`、`/redeem`、`/close` 的 `reason` 是給營運看的內部訊息（多半中文）。
// 下面的 reason 都是 backend `245c22a` 實際會回的句子（scheduler.ts、rebalance-plan.ts、operator.ts、chain.ts）。

/** 白話訊息裡不可以出現中文，也不可以出現後端的代碼。 */
function expectPlainEnglish(text: string) {
  expect(text).not.toMatch(/[　-鿿＀-￯]/);
  expect(text).not.toMatch(/\[[A-Z_]+\]/);
  expect(text.length).toBeGreaterThan(20);
}

const KNOWN: [outcome: string, reason: string, kind: TradeFailureKind][] = [
  // A3 最終重跑看到的那一句（backend#54）。
  ["blocked", "聚合器刷新失敗或 venue 改變，不送交易", "quote-refresh"],
  ["blocked", "送出前重問地板失敗：step#0 的 minimum 是 0（合約會 revert NoFloor）", "quote-refresh"],
  ["blocked", "聚合器刷新缺少 executor/deadline，不送交易", "quote-refresh"],
  // A10 的三種。
  ["blocked", "ExecutorPaused：Safe 已開啟 executor 全域暫停，所有再平衡（含賣出）停止；使用者可用錢包直接提領", "platform-paused"],
  ["reverted", "上鏈但沒有成功：tx 0xabc（第 1 次嘗試，operations 記為 reverted 可重試）｜ExecutorPaused()", "platform-paused"],
  ["blocked", "規劃器擋下（不執行）：買入額度：cap 1000 × 98% − bought 980 → 可買 0，windowEndsAt 1794614400；等待買入窗口結束", "buy-limit"],
  ["reverted", "上鏈但沒有成功：tx 0xabc｜BuyLimitExceeded(1000, 1200)", "buy-limit"],
  ["blocked", "鏈上 enrollment 是 paused：executor 會 revert，這一輪不送", "account-paused"],
  ["reverted", "上鏈但沒有成功：tx 0xabc｜Paused()", "account-paused"],
  // 價格來源（backend#53 解出來的三種）。
  ["blocked", "資產 0x1111111111111111111111111111111111111111：StaleFeed：secondary push feed 0x2222222222222222222222222222222222222222，updatedAt=1794000000；年齡 9000 秒，上限 3600 秒，超時 5400 秒，本輪不交易此資產", "price-source"],
  ["blocked", "資產 0x1111111111111111111111111111111111111111：SourcesDisagree：Pancake TWAP=100，secondary=120，差距 1666 bps，本輪不交易此資產", "price-source"],
  ["blocked", "InvalidAnswer：secondary push feed 0x2222222222222222222222222222222222222222 回傳 0（必須 > 0），本輪不交易此資產", "price-source"],
  ["noop", "StaleFeed(0x2222…). Not sending empty steps.", "price-source"],
  // 讀不到資料：不可以說成「已暫停」或「額度用完」。
  ["blocked", "[EXECUTOR_PAUSE_UNAVAILABLE] 讀不到 executor.globalPaused()，這一輪全部 blocked，不送交易", "data-unavailable"],
  ["blocked", "規劃器擋下（不執行）：[BUY_ALLOWANCE_UNAVAILABLE] buyAllowance 讀取失敗或資料缺漏，無法確認買入額度，不送交易", "data-unavailable"],
  ["blocked", "[MAX_LEG_UNAVAILABLE] 缺少單筆限額", "data-unavailable"],
  ["blocked", "[REDEEM_PLAN_UNAVAILABLE] 持倉、限額、oracle 或 DB 資料不可用，不送交易", "data-unavailable"],
  ["blocked", "[USER_OP_EVIDENCE_UNAVAILABLE] 無法取得有效的原 nonce／deadline，不寫 pending、不送交易", "data-unavailable"],
  // 前置檢查。
  ["blocked", "Pre-checks failed (not sending a transaction that is certain to fail)：[ALLOWANCE_TOO_LOW] step#0 allowance(0xeth, account → executor) = 0 < amountIn 5", "approval"],
  ["blocked", "Pre-checks failed (not sending a transaction that is certain to fail)：[INSUFFICIENT_BALANCE] step#0 balanceOf(0xeth, 0xacc) = 1 < amountIn 5", "balance-changed"],
  ["blocked", "Pre-checks failed (not sending a transaction that is certain to fail)：[SESSION_KEY_NOT_INSTALLED] DB 沒有未過期的 active session key（沒有列，不是「沒安裝」）；[ALLOWANCE_TOO_LOW] step#0 …", "permission"],
  // 單筆上限與路徑。
  ["blocked", "沒有可執行的賣出步驟：[MAX_LEG_ZERO] 資產單筆上限為 0，不交易", "asset-disabled"],
  ["blocked", "[MAX_LEG_QUOTE_INVALID] 縮量後 oracle 名義額仍超限，不交易", "trade-limit"],
  ["blocked", "規劃器擋下（不執行）：白名單 venue 沒有符合地板的路徑", "no-route"],
  ["blocked", "oracle.previewSwap 的 minimum 是 0：合約會 revert NoFloor（沒有地板不等於地板是 0）", "no-route"],
  ["reverted", "上鏈但沒有成功：tx 0xabc｜BelowFloor(100, 99)", "price-moved"],
  // 提領／清倉自己的訊息。
  ["blocked", "要提領的 usd 超過投組總值", "over-total"],
  ["noop", "提領比例換算後待賣代幣量為 0", "too-small"],
  ["noop", "nothing to sell", "nothing-to-sell"],
  ["blocked", "沒有非現金部位可滿足待賣名義額", "nothing-to-sell"],
  ["blocked", "排程器沒有認領 portfolio 1（排程狀態或 smart account 不允許）", "busy"],
  // 在途與對帳。
  ["blocked", "送出結果未知，保留在途，下一輪先對帳，不重送：bundler timeout", "unconfirmed"],
  ["blocked", "portfolio 還在 submitted（1 筆未決操作），結果未知，先對帳，不重送", "in-flight"],
  ["blocked", "先對帳：receipt 尚未取得或證據不完整，保留在途，不重送", "in-flight"],
  ["reverted", "先對帳完成：reverted，這一輪沒有重送交易", "settled-earlier"],
  ["noop", "operations 閘門擋下：這組參數已經 confirmed 過（idempotency_key abc），不重複執行", "already-done"],
];

test("every known backend reason maps to its own plain-English message", () => {
  for (const [outcome, reason, kind] of KNOWN) {
    const failure = explainTradeFailure({ outcome, reason });
    expect([reason, failure.kind]).toEqual([reason, kind]);
    expect(failure.recognized).toBe(true);
    expectPlainEnglish(failure.summary);
    expectPlainEnglish(failure.message);
    expect(failure.message.startsWith(failure.summary)).toBe(true);
    // 原文與 outcome 只在 technical 裡。
    expect(failure.technical).toBe(`outcome: ${outcome}\n${reason}`);
  }
});

test("the reason A3 saw no longer reaches the screen as raw text", () => {
  const failure = explainTradeFailure({ outcome: "blocked", reason: "聚合器刷新失敗或 venue 改變，不送交易" });
  expect(failure.message).toBe(
    "The price could not be re-confirmed just before sending, so the trade was not sent and your funds did not move. This is usually temporary — please try again.",
  );
  const error = new TradeFailureError(failure, { title: "Sale not completed" });
  expect(error.message).toBe(failure.message);
  expect(error.title).toBe("Sale not completed");
  expect(error.technical).toContain("聚合器刷新失敗");
  expect(error).toBeInstanceOf(Error);
});

test("an unknown reason gets a generic message that depends on the outcome, with the raw text kept aside", () => {
  const raw = "drift.assets 少了目標資產 0xabc：drift 與 targets 來自不同的宇宙，不能規劃";
  // blocked／failed：沒有送出，錢沒有動。
  for (const outcome of ["blocked", "failed"]) {
    const failure = explainTradeFailure({ outcome, reason: raw });
    expect(failure).toMatchObject({ kind: "not-sent", recognized: false, message: TRADE_NOT_SENT_MESSAGE });
    expect(failure.technical).toBe(`outcome: ${outcome}\n${raw}`);
  }
  expect(TRADE_NOT_SENT_MESSAGE).toBe("The trade was not sent; your funds did not move. Please try again.");
  // reverted：上鏈了但整筆回滾 —— 持倉沒變，只花了手續費。不可以說「沒有送出」。
  const reverted = explainTradeFailure({ outcome: "reverted", reason: "上鏈但沒有成功：tx 0xabc｜(沒有診斷訊息)" });
  expect(reverted).toMatchObject({ kind: "reverted", recognized: false });
  expect(reverted.message).toContain("reverted");
  expect(reverted.message).not.toContain("was not sent");
  // noop：不是失敗。
  expect(explainTradeFailure({ outcome: "noop", reason: "Planner returned noop: within threshold" })).toMatchObject({
    kind: "nothing-to-do",
    recognized: false,
    message: "Nothing needed to be traded this time.",
  });
  // 什麼都沒給：通用訊息，technical 是空的（畫面就不顯示可展開的區塊）。
  expect(explainTradeFailure({})).toMatchObject({ kind: "not-sent", recognized: false, technical: "" });
  expect(explainTradeFailure({ outcome: null, reason: "  " }).technical).toBe("");
  expect(explainTradeFailure({ reason: "some new english reason" }).technical).toBe("some new english reason");
});

test("an unconfirmed send never claims that the funds did not move", () => {
  const failure = explainTradeFailure({ outcome: "blocked", reason: "送出結果未知，保留在途，下一輪先對帳，不重送：(沒有診斷訊息)" });
  expect(failure.kind).toBe("unconfirmed");
  expect(failure.message).not.toContain("did not move");
  expect(failure.message).toContain("Do not retry right away");
});

test("A10 messages carry the pause source and the next buy time from the page", () => {
  const paused = explainTradeFailure({ outcome: "blocked", reason: "鏈上 enrollment 是 paused：executor 會 revert，這一輪不送" }, { pauseSources: ["account"] });
  expect(paused.message).toBe(explainA10Failure("Paused()", { pauseSources: ["account"] })!);
  expect(paused.message).toContain("Open My position to resume it.");

  const limit = explainTradeFailure({ outcome: "reverted", reason: "BuyLimitExceeded" }, { nextBuyAt: 1794614400 });
  expect(limit.kind).toBe("buy-limit");
  expect(limit.message).toContain("Next buy time:");

  const platform = explainTradeFailure({ outcome: "blocked", reason: "ExecutorPaused()" });
  expect(platform.message).toBe(PLATFORM_PAUSED_MESSAGE);
  // A10 的句子不拆：summary 與 message 相同。
  expect(platform.summary).toBe(platform.message);
});

test("'could not read' codes are not reported as paused or as a used-up allowance", () => {
  // 這兩個代碼字面上含有 A10 的關鍵字。
  expect(explainA10Failure("[EXECUTOR_PAUSE_UNAVAILABLE] 讀不到 executor.globalPaused()，這一輪全部 blocked，不送交易")).toBeNull();
  expect(explainA10Failure("[BUY_ALLOWANCE_UNAVAILABLE] buyAllowance 讀取失敗或資料缺漏，無法確認買入額度，不送交易")).toBeNull();
  // 真的暫停／額度用完仍然認得。
  expect(explainA10Failure("ExecutorPaused()")).toBe(PLATFORM_PAUSED_MESSAGE);
  expect(explainA10Failure("BuyLimitExceeded")).toContain("buy allowance is used up");
});

test("the summary alone never tells the user to try again (used after a buy, where retrying means paying again)", () => {
  for (const [outcome, reason] of KNOWN) {
    const { kind, summary } = explainTradeFailure({ outcome, reason });
    // A10 的句子是整句沿用（「賣出與提領仍可用」「到 My position 恢復」），不在此限。
    if (kind === "platform-paused" || kind === "buy-limit" || kind === "account-paused") continue;
    expect([kind, /try again|retry/i.test(summary)]).toEqual([kind, false]);
  }
  expect(explainTradeFailure({ outcome: "blocked", reason: "?" }).summary).toBe("The trade was not sent; your funds did not move.");
});
