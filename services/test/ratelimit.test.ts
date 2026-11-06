import { beforeAll, describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { createApi } from "../src/api/server";
import { forwardedClient, type RateLimit } from "../src/api/ratelimit";
import { loadEnv } from "../src/env";
import type { Plugin } from "../src/plugins";
import type { Db } from "../src/store/db";
import { repo } from "../src/store/repo";
import { freshDb } from "./db";

const V = "0x00000000000000000000000000000000000000c3";
const BOOK = "0x0000000000000000000000000000000000000001" as Address;

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});

const plugin: Plugin = { name: "extra", api: (app) => void app.get("/extra", (c) => c.json({ ok: true })) };

function api(limit?: RateLimit, clock = { t: 1_000 }) {
  const app = createApi({
    db, repo: repo(db), vaults: async () => [], liveAlarms: async () => [], watchers: [], alarmBook: BOOK, chainId: 4663, now: () => clock.t,
    health: async () => ({ ok: true }), healthToken: "h".repeat(16), telegram: async () => {}, telegramSecret: "s".repeat(16), plugins: [plugin], rateLimit: limit,
  });
  const get = (path: string, ip?: string, env?: unknown) => app.request(path, { headers: ip ? { "x-forwarded-for": ip } : {} }, env as never);
  return { app, get, clock };
}

const hit = async (get: ReturnType<typeof api>["get"], path: string, n: number, ip?: string) => {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await get(path, ip)).status);
  return codes;
};

describe("rate limit on public reads", () => {
  test("/vaults answers up to the limit, then 429 with Retry-After and the usual CORS header", async () => {
    const { get } = api({ perMin: 5, proxyHops: 1 });
    expect(await hit(get, "/vaults", 5, "3.3.3.3")).toEqual([200, 200, 200, 200, 200]);
    const over = await get("/vaults", "3.3.3.3");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "too many requests" });
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(over.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(over.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("the count is per address, and one busy address does not slow another", async () => {
    const { get } = api({ perMin: 3, proxyHops: 1 });
    await hit(get, "/vaults", 4, "3.3.3.3");
    expect((await get("/vaults", "3.3.3.3")).status).toBe(429);
    expect((await get("/vaults", "4.4.4.4")).status).toBe(200);
  });

  test("the budget is shared by every read route", async () => {
    const { get } = api({ perMin: 4, proxyHops: 1 });
    for (const p of ["/vaults", "/alarms/live", `/risk/${V}`, `/presets/${V}`]) expect((await get(p, "5.5.5.5")).status).not.toBe(429);
    for (const p of ["/vaults", "/alarms/live", `/risk/${V}`, `/presets/${V}`, "/extra"]) expect((await get(p, "5.5.5.5")).status).toBe(429);
  });

  test("a plugin's routes are covered too", async () => {
    const { get } = api({ perMin: 2, proxyHops: 1 });
    expect(await hit(get, "/extra", 3, "6.6.6.6")).toEqual([200, 200, 429]);
  });

  test("the window resets after a minute", async () => {
    const { get, clock } = api({ perMin: 2, proxyHops: 1 });
    expect(await hit(get, "/vaults", 3, "3.3.3.3")).toEqual([200, 200, 429]);
    clock.t += 59;
    expect((await get("/vaults", "3.3.3.3")).status).toBe(429);
    clock.t += 1;
    expect((await get("/vaults", "3.3.3.3")).status).toBe(200);
  });

  test("a limit of 0 turns it off", async () => {
    const { get } = api({ perMin: 0, proxyHops: 1 });
    expect((await hit(get, "/vaults", 30, "3.3.3.3")).every((c) => c === 200)).toBe(true);
  });

  test("by default it allows a normal page's worth of reads and stops a hammering one", async () => {
    const { get } = api();
    const codes = await hit(get, "/vaults", 125, "8.8.8.8");
    expect(codes.slice(0, 120).every((c) => c === 200)).toBe(true);
    expect(codes.slice(120).every((c) => c === 429)).toBe(true);
  });

  test("the health check and the POST routes are not counted", async () => {
    const { app, get } = api({ perMin: 1, proxyHops: 1 });
    await get("/vaults", "3.3.3.3");
    expect((await get("/vaults", "3.3.3.3")).status).toBe(429);
    for (let i = 0; i < 5; i++) {
      const h = await app.request("/health", { headers: { "x-forwarded-for": "3.3.3.3", authorization: `Bearer ${"h".repeat(16)}` } });
      expect(h.status).toBe(200);
      const tg = await app.request("/tg/webhook", { method: "POST", headers: { "x-forwarded-for": "3.3.3.3", "x-telegram-bot-api-secret-token": "s".repeat(16) }, body: "{}" });
      expect(tg.status).toBe(200);
    }
  });
});

describe("which address is the caller's", () => {
  test("behind one proxy, the last X-Forwarded-For entry counts, so a caller can't pick its own", async () => {
    const { get } = api({ perMin: 2, proxyHops: 1 });
    // The proxy appends the address it saw. The caller prepends made-up ones, hoping to look new each time.
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await get("/vaults", `10.0.0.${i}, 9.9.9.9`)).status);
    expect(codes).toEqual([200, 200, 429, 429]);
    expect((await get("/vaults", "9.9.9.10")).status).toBe(200);
  });

  test("with two proxies in front, the entry before the last one is the caller", () => {
    expect(forwardedClient("1.1.1.1, 2.2.2.2, 3.3.3.3", 2)).toBe("2.2.2.2");
    expect(forwardedClient("1.1.1.1, 2.2.2.2, 3.3.3.3", 1)).toBe("3.3.3.3");
    expect(forwardedClient("1.1.1.1", 2)).toBeNull();
  });

  test("zero trusted proxies ignores the header, so a caller can't pretend to be new", async () => {
    const { get } = api({ perMin: 2, proxyHops: 0 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await get("/vaults", `7.7.7.${i}`)).status);
    expect(codes).toEqual([200, 200, 429, 429]);
  });

  test("the connection's own address is used when there is no usable header", async () => {
    const { get } = api({ perMin: 1, proxyHops: 1 });
    const server = (address: string) => ({ requestIP: () => ({ address }) });
    expect((await get("/vaults", undefined, server("1.2.3.4"))).status).toBe(200);
    expect((await get("/vaults", undefined, server("1.2.3.4"))).status).toBe(429);
    expect((await get("/vaults", undefined, server("1.2.3.5"))).status).toBe(200);
    // Bun hands the server over as the env, but an adapter may nest it.
    expect((await get("/vaults", undefined, { server: server("1.2.3.6") })).status).toBe(200);
    expect((await get("/vaults", undefined, { server: server("1.2.3.6") })).status).toBe(429);
    // A server that throws, or nothing at all, shares the "unknown" bucket rather than failing the request.
    expect((await get("/vaults", undefined, { requestIP: () => { throw new Error("closed"); } })).status).toBe(200);
  });

  test("a header that isn't an address is ignored, and IPv4-in-IPv6 is read as IPv4", () => {
    expect(forwardedClient("not-an-ip", 1)).toBeNull();
    expect(forwardedClient("", 1)).toBeNull();
    expect(forwardedClient("1.2.3.4", 0)).toBeNull();
    expect(forwardedClient("::ffff:1.2.3.4", 1)).toBe("1.2.3.4");
    expect(forwardedClient("2001:DB8::1", 1)).toBe("2001:db8::1");
  });

  test("a flood of new addresses doesn't grow the table forever, and still serves everyone", async () => {
    const { get } = api({ perMin: 1, proxyHops: 1 });
    let bad = 0;
    for (let i = 0; i < 20_300; i++) if ((await get("/alarms/live", `11.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`)).status !== 200) bad++;
    expect(bad).toBe(0);
    // The oldest addresses were forgotten, so they get a fresh budget.
    expect((await get("/alarms/live", "11.0.0.0")).status).toBe(200);
  });
});

describe("settings", () => {
  const base = { PUBLIC_URL: "https://x.example", DATABASE_URL: "postgres://x", CHAIN_ID: "4663", RPC_URL: "https://a.example", RPC_URL_BACKUP: "https://b.example", TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_WEBHOOK_SECRET: "s".repeat(16), ALERTS_ONLY: "true" };

  test("the defaults are 120 reads a minute and one trusted proxy", () => {
    const e = loadEnv(base);
    expect(e.RATE_LIMIT_PER_MIN).toBe(120);
    expect(e.TRUSTED_PROXY_HOPS).toBe(1);
  });

  test("both can be set, and a negative or fractional value is refused", () => {
    expect(loadEnv({ ...base, RATE_LIMIT_PER_MIN: "30", TRUSTED_PROXY_HOPS: "0" })).toMatchObject({ RATE_LIMIT_PER_MIN: 30, TRUSTED_PROXY_HOPS: 0 });
    expect(() => loadEnv({ ...base, RATE_LIMIT_PER_MIN: "-1" })).toThrow();
    expect(() => loadEnv({ ...base, TRUSTED_PROXY_HOPS: "1.5" })).toThrow();
  });
});
