// A watcher run from the shared image with ROLE=watcher and only the settings it uses. The env check used to want a
// Telegram token, a public URL, a second RPC endpoint and the router, adapter and plan payment addresses it never reads.
// It keeps one RPC endpoint: the startup check that the AlarmBook is v2 reads the chain.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { encodeFunctionResult, type Abi } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { alarmBookAbi } from "../src/chain/abi";
import { loadEnv } from "../src/env";
import type { Db } from "../src/store/db";
import { WATCHER_UNUSED, watcherProblems } from "../src/watcher/quickstart";

const BOOK = "0x00000000000000000000000000000000000000d5";
const KEY = generatePrivateKey();
const ME = "0xabababababababababababababababababababab";

/** Exactly what deploy/watcher.env.example asks a watcher operator to fill in. */
const minimal = {
  ROLE: "watcher",
  DATABASE_URL: "postgres://watcher:pw@db.invalid:5432/watcher",
  CHAIN_ID: "4663",
  ALARM_BOOK: BOOK,
  RPC_URL: "http://rpc.test/a",
  WATCHER_PRIVATE_KEY: KEY,
  ANTHROPIC_API_KEY: "test-key-not-real",
  WATCHERS: `${ME},0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd`,
  WATCHER_PEERS: "https://api-a.invalid,https://api-b.invalid/base",
  FEED_URLS: "https://feed.invalid/rss.xml",
  CARD_VAULTS: "0x00000000000000000000000000000000000000c9",
};

describe("the env check for ROLE=watcher", () => {
  test("accepts the minimal settings and fills the ones a watcher never reads", () => {
    const e = loadEnv(minimal);
    expect(e.ROLE).toEqual(["watcher"]);
    expect(e.PUBLIC_URL).toBe(WATCHER_UNUSED.PUBLIC_URL!);
    expect(e.TELEGRAM_BOT_TOKEN).toBe(WATCHER_UNUSED.TELEGRAM_BOT_TOKEN!);
    expect(e.RPC_URL).toBe(minimal.RPC_URL); // the one setting a watcher reads that the other roles also have: the v2 check needs a node
    expect(e.RPC_URL_BACKUP).toBe(minimal.RPC_URL);
    expect(e.ROUTER).toBeUndefined();
    expect(e.PLAN_TOKEN).toBeUndefined();
  });

  test("keeps any value the operator does set, and treats a blank line as not set", () => {
    const e = loadEnv({ ...minimal, RPC_URL: "https://rpc.invalid", PUBLIC_URL: "", TELEGRAM_BOT_TOKEN: "" });
    expect(e.RPC_URL).toBe("https://rpc.invalid");
    expect(e.RPC_URL_BACKUP).toBe("https://rpc.invalid"); // follows RPC_URL when left blank
    expect(loadEnv({ ...minimal, RPC_URL_BACKUP: "https://rpc2.invalid" }).RPC_URL_BACKUP).toBe("https://rpc2.invalid");
    expect(e.PUBLIC_URL).toBe(WATCHER_UNUSED.PUBLIC_URL!);
    expect(e.TELEGRAM_BOT_TOKEN).toBe(WATCHER_UNUSED.TELEGRAM_BOT_TOKEN!);
  });

  test("names what is missing instead of starting a watcher that does nothing", () => {
    const missing = (patch: Record<string, string | undefined>) => {
      try {
        loadEnv({ ...minimal, ...patch });
        return [];
      } catch (e) {
        return (e as { issues: { path: string[] }[] }).issues.map((i) => i.path[0]);
      }
    };
    expect(missing({ ALARM_BOOK: undefined })).toEqual(["ALARM_BOOK"]);
    expect(missing({ RPC_URL: undefined })).toEqual(["RPC_URL"]); // the v2 check at start needs a node
    expect(missing({ WATCHER_PRIVATE_KEY: undefined })).toEqual(["WATCHER_PRIVATE_KEY"]);
    expect(missing({ WATCHER_PRIVATE_KEY: "0x1234" })).toEqual(["WATCHER_PRIVATE_KEY"]);
    expect(missing({ ANTHROPIC_API_KEY: undefined })).toEqual(["ANTHROPIC_API_KEY"]);
    expect(missing({ DATABASE_URL: undefined })).toEqual(["DATABASE_URL"]);
    expect(missing({ CHAIN_ID: undefined })).toEqual(["CHAIN_ID"]);
    expect(missing({ ALERTS_ONLY: "true" })).toEqual(["ALERTS_ONLY"]);
    expect(missing({ WATCHERS: "not-an-address" })).toEqual(["WATCHERS"]);
    expect(missing({ WATCHER_PEERS: "https://api-a.invalid/" })).toEqual(["WATCHER_PEERS"]);
    expect(missing({ FEED_URLS: "http://feed.invalid/rss.xml" })).toEqual(["FEED_URLS"]);
  });

  test("lists may be empty, as in a rehearsal that only reads feeds", () => {
    expect(() => loadEnv({ ...minimal, WATCHERS: "", WATCHER_PEERS: "", FEED_URLS: "" })).not.toThrow();
  });

  test("no other role is relaxed", () => {
    const issues = (raw: Record<string, string>) => {
      try {
        loadEnv(raw);
        return [];
      } catch (e) {
        return (e as { issues: { path: string[] }[] }).issues.map((i) => i.path[0]);
      }
    };
    const telegram = { PUBLIC_URL: "https://api.invalid", RPC_URL: "https://rpc.invalid", RPC_URL_BACKUP: "https://rpc2.invalid", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_WEBHOOK_SECRET: "x".repeat(16) };
    for (const role of ["all", "api", "bot", "indexer", "detector", "keeper", "watcher,keeper"]) {
      // The watcher's fills and its relaxed check are for a watcher alone. Every other role still wants the router and adapter...
      expect(issues({ ...minimal, ...telegram, ROLE: role })).toEqual(expect.arrayContaining(["ROUTER", "ADAPTER_4626"]));
    }
    for (const role of ["all", "api", "bot"]) {
      // ...and the roles that answer Telegram still want the public URL and the bot's settings.
      expect(issues({ ...minimal, RPC_URL_BACKUP: telegram.RPC_URL_BACKUP, ROLE: role })).toEqual(expect.arrayContaining(["PUBLIC_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]));
    }
  });

  test("the check itself is a pure function of the settings", () => {
    expect(watcherProblems({ ALERTS_ONLY: false, ALARM_BOOK: BOOK, WATCHER_PRIVATE_KEY: KEY, ANTHROPIC_API_KEY: "k", WATCHERS: "", WATCHER_PEERS: "", FEED_URLS: "" })).toEqual([]);
    expect(watcherProblems({ ALERTS_ONLY: false, WATCHERS: "", WATCHER_PEERS: "", FEED_URLS: "" }).map((p) => p.path)).toEqual(["ALARM_BOOK", "WATCHER_PRIVATE_KEY", "ANTHROPIC_API_KEY"]);
  });
});

describe("starting the service with only those settings", () => {
  const saved = { env: { ...process.env }, console: { ...console }, fetch: globalThis.fetch };
  let restoreModules: () => void = () => {};
  let db: Db;

  beforeAll(async () => {
    const real = { ...(await import("../src/store/db")) };
    mock.module("../src/store/db", () => ({ ...real, postgres: () => db }));
    restoreModules = () => mock.module("../src/store/db", () => real);
  });

  afterAll(() => {
    restoreModules();
    globalThis.fetch = saved.fetch;
    Object.assign(console, saved.console);
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
  });

  test("reads its feed, with no Telegram, public URL, RPC or router settings anywhere", async () => {
    const pg = new PGlite();
    db = { query: async (s, p = []) => (await pg.query(s, p as never[])).rows as never, exec: async (s) => void (await pg.exec(s)) };
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      asked.push(req.url);
      if (new URL(req.url).host === "rpc.test") {
        // The startup check reads REBASE_AFTER() on the AlarmBook, and never the router, which this watcher does not have.
        const call = async (m: { id: number; method: string; params?: { data?: string }[] }) => {
          if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x1237" };
          if (m.method === "eth_call") {
            asked.push(`eth_call ${m.params?.[0]?.data?.slice(0, 10)}`);
            return { jsonrpc: "2.0", id: m.id, result: encodeFunctionResult({ abi: alarmBookAbi as Abi, functionName: "REBASE_AFTER", result: 604_800n }) };
          }
          return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method} in this test` } };
        };
        const body = (await req.json()) as never;
        return Response.json(Array.isArray(body) ? await Promise.all((body as Parameters<typeof call>[0][]).map(call)) : await call(body));
      }
      if (req.url.startsWith("http://127.0.0.1:9/feed.xml")) {
        return new Response(`<rss><channel><item><title>Report</title><description>A sample report.</description></item></channel></rss>`);
      }
      throw new Error("no network in this test");
    }) as never;
    // Start from nothing: whatever this machine or an earlier test left in the environment must not help.
    for (const k of Object.keys(process.env)) if (k in minimal || k in WATCHER_UNUSED || ["ROUTER", "ADAPTER_4626", "PLAN_TOKEN", "PLAN_PAY_ADDRESS", "ANTHROPIC_BASE_URL", "OPS_CHAT_ID", "BOT_MODE", "KEEPER_PRIVATE_KEY", "ALERTS_ONLY"].includes(k)) delete process.env[k];
    Object.assign(process.env, { ...minimal, DATABASE_URL: "pglite://memory", FEED_URLS: "http://127.0.0.1:9/feed.xml", WATCHER_PEERS: "", LOOP_SCALE: "0.001" });
    const errors: string[] = [];
    for (const level of ["log", "info", "warn", "debug"] as const) console[level] = () => {};
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));

    const svc = (await import(`../src/index.ts?quickstart=${Date.now()}`)) as { stop: () => void; server?: unknown };
    try {
      const end = Date.now() + 10_000;
      let rows: unknown[] = [];
      while (Date.now() < end && rows.length === 0) {
        await Bun.sleep(20);
        rows = await db.query(`SELECT 1 FROM feed_items WHERE source_url=$1`, ["http://127.0.0.1:9/feed.xml"]);
      }
      expect(rows).toHaveLength(1);
      expect(svc.server).toBeUndefined(); // a watcher opens no port
      expect(asked.some((u) => u.includes("telegram"))).toBe(false);
      expect(asked.some((u) => u.startsWith("eth_call"))).toBe(true); // the AlarmBook version check ran (other files' loops may add calls)
    } finally {
      svc.stop();
    }
    // The watcher's only loop is "feeds". A pass may not fail (the offline classifier call is only a warning). Other test
    // files can leave loops running in this process, so only this loop's lines are counted.
    expect(errors.filter((e) => e.startsWith("feeds "))).toEqual([]);
  }, 30_000);
});
