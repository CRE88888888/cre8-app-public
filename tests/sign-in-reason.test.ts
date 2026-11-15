import { expect, test } from "bun:test";
import fs from "node:fs";
import { signInCopy, signInReasonOf } from "../src/lib/sign-in-reason";

// 逛的時候不用登入；要買、要賣、要建立基金的那一刻才出現（整頁的）登入頁。

test("the sign-in page says what you are signing in for, and that you come back", () => {
  expect(signInCopy({ purpose: "buy", subject: "AI Buildout" })).toEqual({
    title: "Sign in to buy",
    body: "You’ll come right back to AI Buildout.",
    button: "Sign in to buy",
  });
  expect(signInCopy({ purpose: "sell", subject: "AI Buildout" })).toMatchObject({ title: "Sign in to sell", button: "Sign in to sell" });
  expect(signInCopy({ purpose: "buy" }).body).toBe("You’ll come right back here.");
  expect(signInCopy({ purpose: "buy", subject: "  " }).body).toBe("You’ll come right back here.");
  expect(signInCopy({ purpose: "create" })).toEqual({
    title: "Sign in to create your fund",
    body: "Your design is saved. You’ll come right back to it.",
    button: "Sign in to create",
  });
  // 自己按標頭的 Sign in：原本的字。
  expect(signInCopy(null)).toEqual({ title: "Sign in to CRE8", body: "Follow the funds you believe in, from one account.", button: "Sign in" });
  expect(signInCopy(undefined).title).toBe("Sign in to CRE8");
});

test("a reason that arrives through an event is checked before it is used", () => {
  expect(signInReasonOf({ purpose: "buy", subject: "X" })).toEqual({ purpose: "buy", subject: "X" });
  expect(signInReasonOf({ purpose: "create" })).toEqual({ purpose: "create" });
  expect(signInReasonOf({ purpose: "create", subject: 5 })).toEqual({ purpose: "create" });
  for (const bad of [undefined, null, "buy", 3, {}, { purpose: "admin" }]) expect(signInReasonOf(bad)).toBeNull();
});

test("the page shows up at the moment of buying, selling or creating, never on opening the app", () => {
  const fund = fs.readFileSync("src/features/fund/FundPage.tsx", "utf8");
  // 下單區四個「沒登入」的位置都帶原因；沒有不帶原因的。
  expect(fund.match(/<WalletMenu inline signInFor=\{\{ purpose: 'buy', subject: fund\.name \}\} \/>/g)?.length).toBe(2);
  expect(fund.match(/<WalletMenu inline signInFor=\{\{ purpose: 'sell', subject: fund\.name \}\} \/>/g)?.length).toBe(2);
  expect(fund).not.toContain("<WalletMenu inline />");

  // 手機：登入頁開著時下單面板先收起來（面板是 modal，登入頁疊在上面會整頁按不到），關掉後才回來。
  expect(fund).toContain("open={mobileTicket && !signInOpen && !ticketHidden}");

  const create = fs.readFileSync("src/features/create/CreateFundPage.tsx", "utf8");
  expect(create).toContain("openSignIn({ purpose: 'create' });");
  // 只在有設計好的基金、而且 Privy 確定沒人登入時自動出現一次。
  expect(create).toContain("draft === null || privyPhase !== 'signed-out' || askedToSignIn.current");

  // 沒有任何「一打開就出現」的邏輯（#66 已還原）。
  const app = fs.readFileSync("src/App.tsx", "utf8");
  const screen = fs.readFileSync("src/components/SignInScreen.tsx", "utf8");
  expect(app + screen).not.toMatch(/openSignIn\(|useLocation|signInEntry/);
  expect(fs.existsSync("src/lib/sign-in-entry.ts")).toBe(false);
});

test("the sign-in sheet always has a way back: Not now, tapping outside, or Escape", () => {
  const screen = fs.readFileSync("src/components/SignInScreen.tsx", "utf8");
  expect(screen).toContain('<div className="signin-screen__backdrop" aria-hidden="true" onClick={closeSignIn} />');
  expect(screen).toContain("if (event.key === 'Escape') closeSignIn();");
  expect(screen).toContain("Not now");
  // iOS 的面板沒有右上角的叉叉；回去的方式是上面三種。
  expect(screen).not.toContain("signin-screen__close");
  const store = fs.readFileSync("src/store/privy.ts", "utf8");
  // 關掉或登入完成都把原因清掉，下一次按標頭的 Sign in 不會沿用上一次的原因。
  expect(store).toContain("usePrivyAuth.setState({ signInOpen: false, signInFor: null });");
  expect(fs.readFileSync("src/features/auth/PrivyRoot.tsx", "utf8")).toContain("signInOpen: false, signInFor: null");
});
