import { test, expect } from "bun:test";
import worker from "../public/_worker.js";

test("waitlist routing: the landing host gates at / and sends app pages to tst; other hosts open the app at /", async () => {
  const env = {
    ASSETS: {
      fetch: (request: Request) => {
        const { host, pathname, search } = new URL(request.url);
        return new Response(host + pathname + search);
      },
    },
  };
  const get = (url: string) => worker.fetch(new Request(url), env);
  // cre8.finance：首頁是 App（waitlist 閘門）；app 頁面 302 到 tst（含查詢參數）。
  expect(await (await get("https://cre8.finance/")).text()).toBe("cre8.finance/");
  // 使用者 2026-11-16：舊的 landing 不再對外，任何網域的 /landing 都導回首頁（waitlist）。
  for (const url of ["https://cre8.finance/landing", "https://cre8.finance/landing/", "https://cre8.finance/landing/assets/app.js", "https://tst.cre8.finance/landing/"]) {
    const response = await get(url);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(new URL(url).origin + "/");
  }
  expect(await (await get("https://cre8.finance/logos/cre8-icon.svg")).text()).toBe("cre8.finance/logos/cre8-icon.svg");
  for (const path of ["/vaults", "/create", "/funds/mag7", "/?period=30D"]) {
    const response = await get("https://cre8.finance" + path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://tst.cre8.finance" + path);
  }
  expect((await get("https://www.cre8.finance/funds/mag7")).headers.get("location")).toBe("https://tst.cre8.finance/funds/mag7");
  // tst 與其他網域：首頁就是 App，頁面不導走。
  expect(await (await get("https://tst.cre8.finance/")).text()).toBe("tst.cre8.finance/");
  expect(await (await get("https://tst.cre8.finance/create")).text()).toBe("tst.cre8.finance/create");
  expect(await (await get("https://cre8-app-migration-preview.example.workers.dev/")).text()).toBe("cre8-app-migration-preview.example.workers.dev/");
  expect(await (await get("https://cre8-atp.pages.dev/?period=30D")).text()).toBe("cre8-atp.pages.dev/?period=30D");
});

test("public history proxy is fixed, read-only and strips wallet credentials", async () => {
  const original = globalThis.fetch,
    calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.redirect === "error")
      throw new TypeError("Workers does not implement redirect:error");
    calls.push({ url: String(input), init });
    return new Response(init?.method === "HEAD" ? null : "{}", {
      headers: { "set-cookie": "upstream=unused" },
    });
  };
  try {
    const response = await worker.fetch(
      new Request(
        "https://cre8-atp.pages.dev/reference-data/demo-funds?url=https://example.invalid",
        {
          headers: {
            Authorization: "Bearer fixture-only",
            Cookie: "fixture=unused",
          },
        },
      ),
      {
        ASSETS: {
          fetch: () => {
            throw new Error("Unexpected static fetch");
          },
        },
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://bnb-agent-vaults.vercel.app/api/demo-funds/",
    );
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    const denied = await worker.fetch(
      new Request("https://cre8-atp.pages.dev/reference-data/demo-funds", {
        method: "POST",
      }),
      {},
    );
    expect(denied.status).toBe(405);
    expect(calls).toHaveLength(1);
    const head = await worker.fetch(
      new Request("https://cre8-atp.pages.dev/reference-data/demo-funds", {
        method: "HEAD",
      }),
      {},
    );
    expect(head.body).toBeNull();
    expect(calls[1].init?.method).toBe("HEAD");
  } finally {
    globalThis.fetch = original;
  }
});
test("preview-only /api never reaches any backend, while static routing keeps its behavior", async () => {
  const original = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = async (input) => {
    outbound.push(String(input));
    return new Response("{}");
  };
  try {
    for (const [path, method] of [
      ["/api", "GET"],
      ["/api/health", "GET"],
      ["/api/portfolios?limit=1", "GET"],
      ["/api/auth/nonce", "POST"],
    ] as const) {
      const response = await worker.fetch(
        new Request("https://cre8-app-migration-preview.example.workers.dev" + path, {
          method,
          headers: { Authorization: "Bearer fixture-only" },
        }),
        {
          ASSETS: {
            fetch: () => {
              throw new Error("Unexpected static fetch");
            },
          },
        },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "PREVIEW_ONLY", message: "App preview" },
      });
    }
    expect(outbound).toHaveLength(0);
    let assets = 0;
    const response = await worker.fetch(
      new Request("https://cre8-app-migration-preview.example.workers.dev/funds/mag7"),
      {
        ASSETS: {
          fetch: () => {
            assets++;
            return new Response("SPA");
          },
        },
      },
    );
    expect(await response.text()).toBe("SPA");
    expect(assets).toBe(1);
    // `/apis` is not an API path and still goes to static assets.
    await worker.fetch(
      new Request("https://cre8-app-migration-preview.example.workers.dev/apis"),
      { ASSETS: { fetch: () => (assets++, new Response("SPA")) } },
    );
    expect(assets).toBe(2);
    expect(outbound).toHaveLength(0);
  } finally {
    globalThis.fetch = original;
  }
});

test("public reference refuses upstream redirects and reports fetch failures without leaving the fixed source", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://unrelated.example" },
      });
    const redirected = await worker.fetch(
      new Request("https://cre8-atp.pages.dev/reference-data/demo-funds"),
      {},
    );
    expect(redirected.status).toBe(502);
    expect(redirected.headers.get("location")).toBeNull();
    globalThis.fetch = async () => {
      throw new Error("Origin unavailable");
    };
    const unavailable = await worker.fetch(
      new Request("https://cre8-atp.pages.dev/reference-data/demo-funds"),
      {},
    );
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toBe(
      "Reference temporarily unavailable",
    );
  } finally {
    globalThis.fetch = original;
  }
});
