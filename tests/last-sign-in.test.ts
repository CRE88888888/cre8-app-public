import { expect, test } from "bun:test";
import fs from "node:fs";
import { LAST_SIGN_IN_KEY, PENDING_SIGN_IN_KEY, confirmSignIn, lastSignIn, notePendingSignIn } from "../src/lib/last-sign-in";

// 登入頁在上次用過的方式標「Last used」：Google 與 email 對使用者是同一件事，對 Privy 卻是兩種登入，按錯可能變成另一個帳號。

function memory(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  } as unknown as Storage;
}

test("a choice only counts once the sign-in really succeeded", () => {
  const session = memory();
  const local = memory();
  expect(lastSignIn(local)).toBeNull();
  // 按了 Google（會整頁轉出去）：還不算。
  notePendingSignIn(session, "google");
  expect(session.getItem(PENDING_SIGN_IN_KEY)).toBe("google");
  expect(lastSignIn(local)).toBeNull();
  // 登入成功：記下來，待確認的清掉。
  expect(confirmSignIn(session, local)).toBe("google");
  expect(lastSignIn(local)).toBe("google");
  expect(session.getItem(PENDING_SIGN_IN_KEY)).toBeNull();
  // 沒有待確認的（例如重新整理後 Privy 自己接回登入）：不動原本的紀錄。
  expect(confirmSignIn(session, local)).toBeNull();
  expect(lastSignIn(local)).toBe("google");
  // 下次改用 email 成功：換成 email。
  notePendingSignIn(session, "email");
  confirmSignIn(session, local);
  expect(local.getItem(LAST_SIGN_IN_KEY)).toBe("email");
});

test("bad or blocked storage never breaks the sign-in page", () => {
  expect(lastSignIn(null)).toBeNull();
  expect(lastSignIn(memory({ [LAST_SIGN_IN_KEY]: "facebook" }))).toBeNull();
  expect(confirmSignIn(memory({ [PENDING_SIGN_IN_KEY]: "nonsense" }), memory())).toBeNull();
  expect(() => notePendingSignIn(null, "wallet")).not.toThrow();
  expect(confirmSignIn(null, null)).toBeNull();
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } as unknown as Storage;
  expect(lastSignIn(throwing)).toBeNull();
  expect(() => notePendingSignIn(throwing, "x")).not.toThrow();
  expect(confirmSignIn(throwing, throwing)).toBeNull();
});

test("the sign-in sheet marks the last-used way on its button", () => {
  const screen = fs.readFileSync("src/components/SignInScreen.tsx", "utf8");
  for (const choice of ["google", "x", "email", "wallet"]) {
    expect(screen).toContain(`data-method="${choice}"`);
    expect(screen).toContain(`{last === '${choice}' && <LastUsed />}`);
  }
  // 按鈕的顏色跟著品牌規範（Google 白、X 黑），不跟著「上次用的」變。
  expect(screen).toContain('className="btn block" data-method="x"');
  expect(screen).toContain('className="btn ghost block" data-method="google"');
  // 成功登入才確認。
  expect(screen).toContain("if (phase === 'signed-in') confirmSignIn(");
});

test("popups and secondary actions follow the iOS language: grouped rows and text buttons, no underlined links", () => {
  const css = fs.readFileSync("src/styles/components.css", "utf8");
  const rule = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };
  expect(rule(".wallet-menu__link")).toContain("text-decoration: none");
  expect(rule(".wallet-menu__item")).toContain("background: var(--app-grouped");
  expect(rule(".wallet-menu__item")).toContain("border: 0");
  expect(rule(".wallet-menu__item")).toContain("min-height: 44px");
  expect(rule(".signin-screen__text")).toContain("min-height: 44px");
  expect(rule(".signin-screen__text")).not.toContain("underline");
  // 登入頁的輸入框是一般字體的分組欄位，不是全站表單的等寬細框。
  expect(rule("#root .signin-screen .field input")).toContain("background: #f1f3f5");
  expect(rule("#root .signin-screen .field input")).toContain("border: 0");
  expect(css).toContain(".field input:not(.signin-screen__code), .signin-screen__text, .signin-last) {\n  font-family: inherit;");
  // 彈窗裡的按鈕是膠囊（登入頁、底部面板、錢包選單），頁面上的一般按鈕不動。
  const shapes = fs.readFileSync("src/styles/system.css", "utf8");
  expect(shapes).toContain(":is(.signin-screen, .app-bottom-sheet, .wallet-menu__panel) .btn { border-radius: var(--r-pill) !important; }");
  // 手機上是從下面滑上來的面板。
  expect(shapes).toContain(".signin-screen__card { border-radius: 28px 28px 0 0 !important; }");
  // Privy 自己的選錢包視窗也套同一套圓角（全站 0 圓角會把它壓成直角，實測）。
  expect(shapes).toContain("#privy-modal-content { border-radius: 28px !important; }");
  expect(shapes).toContain("#privy-modal-content { border-radius: 28px 28px 0 0 !important; }");
  // 登入頁不再借用選單的連結樣式。
  expect(fs.readFileSync("src/components/SignInScreen.tsx", "utf8")).not.toContain("wallet-menu__link");
});
