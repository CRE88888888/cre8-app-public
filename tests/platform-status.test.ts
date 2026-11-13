import { afterEach, expect, test } from "bun:test";
import { getPlatformPaused, platformPausedFrom } from "../src/lib/api";

// cre8-app#41：全站橫幅讀公開的 GET /platform/status。
// 只有「200 + 布林值」算知道答案；其他都是 null（不知道），而且 null 不可以被當成 false。

const body = (globalPaused: unknown) =>
  JSON.stringify({ chainId: 56, executor: "0x33", registry: "0x44", globalPaused, maxBuyBps: 10000, checkedAt: "2026-11-13T00:00:00Z", block: "48211034" });

test("200 with a boolean is a definite answer", () => {
  expect(platformPausedFrom(200, body(true))).toBe(true);
  expect(platformPausedFrom(200, body(false))).toBe(false);
});

test("503 is unknown, whatever the body says", () => {
  expect(platformPausedFrom(503, body(null))).toBeNull();
  // 後端讀鏈失敗時不會回布林值，但就算回了，503 也不採信。
  expect(platformPausedFrom(503, body(false))).toBeNull();
  // A 段臨時網址：/api/* 一律回這個。
  expect(platformPausedFrom(503, JSON.stringify({ error: { code: "PREVIEW_ONLY", message: "App preview" } }))).toBeNull();
});

test("200 without a usable value is unknown, never false", () => {
  expect(platformPausedFrom(200, body(null))).toBeNull();
  expect(platformPausedFrom(200, JSON.stringify({ chainId: 56 }))).toBeNull();
  expect(platformPausedFrom(200, body("false"))).toBeNull();
  expect(platformPausedFrom(200, body(0))).toBeNull();
  expect(platformPausedFrom(200, "null")).toBeNull();
  // 被導到 SPA 的 index.html，或壞掉的 JSON。
  expect(platformPausedFrom(200, "<!doctype html><html></html>")).toBeNull();
  expect(platformPausedFrom(200, "")).toBeNull();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const stubFetch = (respond: (url: string) => Response | Promise<Response>) => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return respond(String(input));
  }) as typeof fetch;
  return calls;
};

test("the request goes to the public endpoint without credentials", async () => {
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenInit = init;
    return new Response(body(true), { status: 200 });
  }) as typeof fetch;
  expect(await getPlatformPaused()).toBe(true);
  expect(JSON.stringify(seenInit ?? {})).not.toMatch(/authorization|Bearer/i);

  const calls = stubFetch(() => new Response(body(false), { status: 200 }));
  expect(await getPlatformPaused()).toBe(false);
  expect(calls).toEqual(["/api/platform/status"]);
});

test("503, a null value and a network failure all come back as unknown without throwing", async () => {
  stubFetch(() => new Response(body(null), { status: 503 }));
  expect(await getPlatformPaused()).toBeNull();

  stubFetch(() => new Response(body(null), { status: 200 }));
  expect(await getPlatformPaused()).toBeNull();

  stubFetch(() => new Response(JSON.stringify({ error: { code: "PREVIEW_ONLY", message: "App preview" } }), { status: 503 }));
  expect(await getPlatformPaused()).toBeNull();

  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  expect(await getPlatformPaused()).toBeNull();
});
