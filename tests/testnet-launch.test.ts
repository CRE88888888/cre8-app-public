import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import worker from "../public/_worker.js";
// @ts-expect-error -- 產生器是 Node 腳本（.mjs），沒有型別宣告。
import { renderAddressBook } from "../scripts/gen-testnet-97.mjs";

// 測試網上線準備（總管 2026-11-16）：tst.cre8.finance 是 chain 97 測試網站，/api 轉發到後端（API_ORIGIN）。

const ORIGIN = "https://api.example.test";
const noAssets = { fetch: () => { throw new Error("Unexpected static fetch"); } };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Seen = { url: string; init: RequestInit & { headers: Headers } };
function capture(response: () => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init as Seen["init"] });
    return response();
  }) as typeof fetch;
  return seen;
}

test("without API_ORIGIN the API stays PREVIEW_ONLY and nothing is forwarded", async () => {
  const seen = capture(() => new Response("{}"));
  for (const env of [{ ASSETS: noAssets }, { ASSETS: noAssets, API_ORIGIN: "" }, { ASSETS: noAssets, API_ORIGIN: "  " }]) {
    const response = await worker.fetch(new Request("https://tst.cre8.finance/api/health"), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "PREVIEW_ONLY", message: "App preview" } });
  }
  expect(seen).toHaveLength(0);
});

test("a bad API_ORIGIN is refused instead of forwarding somewhere unexpected", async () => {
  const seen = capture(() => new Response("{}"));
  for (const bad of ["http://api.example.test", "https://api.example.test/v1", "https://user:pw@api.example.test", "https://api.example.test?x=1", "not a url"]) {
    const response = await worker.fetch(new Request("https://tst.cre8.finance/api/health"), { ASSETS: noAssets, API_ORIGIN: bad });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("API_MISCONFIGURED");
  }
  expect(seen).toHaveLength(0);
});

test("/api/* goes to the backend without the /api prefix, keeping method, query, body and Authorization only", async () => {
  const seen = capture(() => new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json", "x-request-id": "r1", "set-cookie": "s=1", "retry-after": "3" } }));
  const env = { ASSETS: noAssets, API_ORIGIN: ORIGIN + "/" };
  const response = await worker.fetch(new Request("https://tst.cre8.finance/api/waitlist/join?ref=x", {
    method: "POST",
    body: JSON.stringify({ identityToken: "fixture" }),
    headers: {
      Authorization: "Bearer fixture-only", "Content-Type": "application/json", Accept: "application/json",
      Cookie: "session=browser", "X-Forwarded-For": "6.6.6.6", Origin: "https://evil.example", "CF-Connecting-IP": "203.0.113.7", "X-Custom": "1",
    },
  }), env);
  expect(seen).toHaveLength(1);
  const call = seen[0]!;
  // 路徑原樣轉、保留 /api 前綴：後端的 website 服務自己剝掉再轉給 API。
  expect(call.url).toBe("https://api.example.test/api/waitlist/join?ref=x");
  expect(call.init.method).toBe("POST");
  expect(await new Response(call.init.body).text()).toBe('{"identityToken":"fixture"}');
  expect(call.init.redirect).toBe("manual");
  expect(call.init.signal).toBeInstanceOf(AbortSignal);
  expect(Object.fromEntries(call.init.headers.entries())).toEqual({
    authorization: "Bearer fixture-only",
    "content-type": "application/json",
    accept: "application/json",
    // 來源 IP 用 Cloudflare 看到的，不用瀏覽器自己帶的 X-Forwarded-For。
    "x-forwarded-for": "203.0.113.7",
  });
  // 回應原樣：狀態、body、標頭（只拿掉 set-cookie）。
  expect(response.status).toBe(201);
  expect(await response.text()).toBe('{"ok":true}');
  expect(response.headers.get("x-request-id")).toBe("r1");
  expect(response.headers.get("retry-after")).toBe("3");
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("GET has no body, /api alone stays /api, upstream redirects and errors come back as they are", async () => {
  const seen = capture(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
  const env = { ASSETS: noAssets, API_ORIGIN: ORIGIN };
  const response = await worker.fetch(new Request("https://tst.cre8.finance/api"), env);
  expect(seen[0]!.url).toBe("https://api.example.test/api");
  expect(seen[0]!.init.body).toBeUndefined();
  expect(response.status).toBe(302);
  capture(() => Response.json({ error: { code: "X_REQUIRED", message: "link X" } }, { status: 409 }));
  const conflict = await worker.fetch(new Request("https://tst.cre8.finance/api/waitlist/join", { method: "POST", body: "{}" }), env);
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error.code).toBe("X_REQUIRED");
  // 不是 /api 開頭的不轉（例如 /apiary 是 SPA 頁面）。
  let assets = 0;
  await worker.fetch(new Request("https://tst.cre8.finance/apiary"), { ASSETS: { fetch: () => { assets++; return new Response("app"); } }, API_ORIGIN: ORIGIN });
  expect(assets).toBe(1);
});

test("a slow backend times out with 504, an unreachable one is 502", async () => {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  })) as typeof fetch;
  const slow = await worker.fetch(new Request("https://tst.cre8.finance/api/health"), { ASSETS: noAssets, API_ORIGIN: ORIGIN, API_TIMEOUT_MS: "20" });
  expect(slow.status).toBe(504);
  expect((await slow.json()).error.code).toBe("UPSTREAM_TIMEOUT");
  globalThis.fetch = (async () => { throw new TypeError("connect failed"); }) as typeof fetch;
  const down = await worker.fetch(new Request("https://tst.cre8.finance/api/health"), { ASSETS: noAssets, API_ORIGIN: ORIGIN });
  expect(down.status).toBe(502);
  expect((await down.json()).error.code).toBe("UPSTREAM_UNAVAILABLE");
  // 預設 30 秒；後端網址寫在 wrangler.jsonc 的 vars（Railway 的 website 服務，總管 2026-11-17），不用 dashboard 變數。
  expect(fs.readFileSync("public/_worker.js", "utf8")).toContain("const API_TIMEOUT_MS = 30_000;");
  const wrangler = fs.readFileSync("wrangler.jsonc", "utf8");
  expect(wrangler).toContain('"vars": { "API_ORIGIN": "https://website-production-d8e9f7cc.up.railway.app" },');
  expect(wrangler).not.toContain("keep_vars");
});

test("the configured API_ORIGIN is accepted and /api goes there with the prefix kept", async () => {
  const configured = fs.readFileSync("wrangler.jsonc", "utf8").match(/"API_ORIGIN": "([^"]*)"/)?.[1];
  expect(configured).toBe("https://website-production-d8e9f7cc.up.railway.app");
  const seen = capture(() => Response.json({ ok: true }));
  const response = await worker.fetch(new Request("https://tst.cre8.finance/api/health?x=1"), { ASSETS: noAssets, API_ORIGIN: configured });
  expect(response.status).toBe(200);
  expect(seen[0]!.url).toBe("https://website-production-d8e9f7cc.up.railway.app/api/health?x=1");
});

test("the production build is testnet (chain 97); mainnet keeps its own env file and build script", () => {
  const env = (file: string) => Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  const testnet = env(".env.production");
  const mainnet = env(".env.mainnet");
  expect(testnet.VITE_CHAIN_ID).toBe("97");
  expect(testnet.VITE_RPC_URL).toBe("https://bsc-testnet.publicnode.com");
  expect(mainnet.VITE_CHAIN_ID).toBe("56");
  expect(mainnet.VITE_RPC_URL).toBe("https://bsc-rpc.publicnode.com");
  // 其他設定兩邊一樣（waitlist、Privy、WalletConnect、API 位置）。
  const rest = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([key]) => key !== "VITE_CHAIN_ID" && key !== "VITE_RPC_URL"));
  expect(rest(testnet)).toEqual(rest(mainnet));
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  expect(pkg.scripts.build).toBe("tsc --noEmit && vite build");
  expect(pkg.scripts["build:mainnet"]).toBe("tsc --noEmit && vite build --mode mainnet");
  expect(fs.readFileSync("docs/deploy-cloudflare.md", "utf8")).toContain("bun run build:mainnet");
});

test("the address book generator renders a manifest deterministically and refuses a broken one", () => {
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const manifest = {
    chainId: 97, mode: "public", verifiedAtBlock: 123, generatedAt: "2026-11-20T00:00:00Z", gitCommit: "a".repeat(40),
    contracts: Object.fromEntries(["registry", "router", "executor", "yieldRegistry", "yieldView", "usdt", "paymaster", "gasPolicy", "entryPoint", "universalRouter", "permit2"].map((key, i) => [key, address(i + 1)])),
    assets: { Von: { token: address(20) }, VRTon: { token: address(21) }, AAVE: { token: address(22) } },
    yieldMarkets: [{ protocol: "Aave", symbol: "USDT", asset: address(6), receipt: address(30), marketId: `0x${"ab".repeat(32)}` }],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const out = renderAddressBook(bytes, "b".repeat(40)) as string;
  expect(out).toBe(renderAddressBook(bytes, "b".repeat(40)));
  expect(out).toContain(`    registry: '${address(1)}',`);
  // 資產照名稱不分大小寫排序（與現行檔案相同）。
  expect(out.indexOf("    AAVE:")).toBeLessThan(out.indexOf("    Von:"));
  expect(out.indexOf("    Von:")).toBeLessThan(out.indexOf("    VRTon:"));
  expect(out).toContain("{ id: 'aave_v3_usdt', protocol: 'aave_v3', symbol: 'USDT'");
  expect(out).toContain("`mode: \"public\"`");
  expect(out.endsWith("} as const;\n")).toBe(true);
  expect(() => renderAddressBook(Buffer.from(JSON.stringify({ ...manifest, chainId: 56 })), "b".repeat(40))).toThrow();
  expect(() => renderAddressBook(Buffer.from(JSON.stringify({ ...manifest, contracts: { ...manifest.contracts, executor: "0x12" } })), "b".repeat(40))).toThrow();
  expect(() => renderAddressBook(bytes, "short")).toThrow();
  // 現行地址簿就是這支產生器的輸出（標頭寫著來源 commit 與 sha256）。
  const book = fs.readFileSync("src/lib/testnet-97.ts", "utf8");
  expect(book).toContain("**產生的檔案，不要手改。**");
  expect(book).toContain("commit: 'cbc671d395e89357b7bf3726c37775ba1f42ef35',");
});
