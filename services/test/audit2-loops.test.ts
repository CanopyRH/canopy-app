// Audit 2 PoCs that need src/index.ts itself, loaded the way index.test.ts loads it: a stand-in chain answered in
// process, an in-process Postgres, and a bot whose Telegram calls are answered locally. Nothing opens a port.
//
// A2-L1: the watcher's feed loop checks scope once per registered QUORUM detector, and every check re-runs the whole
//        liveKeys query. Registering a QUORUM detector is open to anyone and has no code check, so detectors are
//        cheap, and the loop's cost grows as detectors x positions before any report is even looked at.
// A2-M4: the detector role scans followed vaults before listed ones, one after another. Anyone can follow any
//        contract through the bot, so slow contracts push back the scans that feed the watchers' on-chain signal.
//
// Run: bun test test/audit2-loops.test.ts
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { numberToHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import type { Db } from "../src/store/db";
import { repo } from "../src/store/repo";

const ROUTER = "0x00000000000000000000000000000000000000d4" as Address;
const BOOK = "0x00000000000000000000000000000000000000d5" as Address;
const ADAPTER = "0x00000000000000000000000000000000000000d6" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d7" as Address;
const PAY = "0x00000000000000000000000000000000000000d8" as Address;
const LISTED = "0x00000000000000000000000000000000000000c9" as Address;
const OWNER = "0xabababababababababababababababababababab";
const followed = (i: number) => `0x00000000000000000000000000000000000f${i.toString(16).padStart(4, "0")}` as Address;

const saved = { env: { ...process.env }, console: { ...console }, fetch: globalThis.fetch };
let restoreModules: () => void = () => {};
let current: { stop: () => void } | undefined;
let db: Db;
let counting = { liveKeys: 0 };
/** The stand-in node: how long a call to each address takes, and when the listed vault was first read. */
let slow = new Set<string>();
let listedFirstRead = 0;
let rpcDelayMs = 50;

async function rpcNode(req: Request) {
  const one = async (m: { id: number; method: string; params: unknown[] }) => {
    const target = ((m.params?.[0] as { to?: string; address?: string } | string | undefined) ?? "") as never as { to?: string } | string;
    const to = (typeof target === "string" ? target : target?.to ?? "").toLowerCase();
    if (to === LISTED.toLowerCase() && !listedFirstRead) listedFirstRead = performance.now();
    if (slow.has(to)) await Bun.sleep(rpcDelayMs);
    switch (m.method) {
      case "eth_chainId": return { jsonrpc: "2.0", id: m.id, result: "0x1237" };
      case "eth_blockNumber": return { jsonrpc: "2.0", id: m.id, result: numberToHex(1000n) };
      case "eth_getCode": return { jsonrpc: "2.0", id: m.id, result: "0x6001" };
      default: return { jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted" } };
    }
  };
  const body = (await req.json()) as never;
  return Response.json(Array.isArray(body) ? await Promise.all((body as never[]).map(one)) : await one(body));
}

beforeAll(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).host === "rpc.test") return rpcNode(req);
    throw new Error(`no network in this test: ${new URL(req.url).host}`);
  }) as never;
  const real = { ...(await import("../src/store/db")) };
  mock.module("../src/store/db", () => ({ ...real, postgres: () => db }));
  const realBot = { ...(await import("../src/bot/bot")) };
  mock.module("../src/bot/bot", () => ({
    ...realBot,
    createBot: (...a: Parameters<typeof realBot.createBot>) => {
      const bot = realBot.createBot(...a);
      bot.api.config.use((async () => ({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } })) as never);
      return bot;
    },
  }));
  restoreModules = () => {
    mock.module("../src/store/db", () => real);
    mock.module("../src/bot/bot", () => realBot);
  };
});

afterEach(() => {
  current?.stop();
  current = undefined;
  Object.assign(console, saved.console);
});

afterAll(() => {
  restoreModules();
  globalThis.fetch = saved.fetch;
  for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
  Object.assign(process.env, saved.env);
});

async function freshPg() {
  const pg = new PGlite();
  const inner: Db = { query: async (s, p = []) => (await pg.query(s, p as never[])).rows as never, exec: async (s) => void (await pg.exec(s)) };
  db = {
    query: async (s, p) => {
      if (s.includes("WITH armed AS")) counting.liveKeys++;
      return inner.query(s, p);
    },
    exec: inner.exec,
  };
  const { migrate } = await import("../src/store/db");
  await migrate(db);
  return db;
}

/** Loads a fresh copy of src/index.ts with these settings. Each copy runs its own loops until stop(). */
async function boot(role: string, tag: string) {
  Object.assign(process.env, {
    ROLE: role, PORT: "0", PUBLIC_URL: "https://api.example.test", DATABASE_URL: "pglite://memory", CHAIN_ID: "4663",
    RPC_URL: "http://rpc.test/a", RPC_URL_BACKUP: "http://rpc.test/b",
    ROUTER, ALARM_BOOK: BOOK, ADAPTER_4626: ADAPTER, PLAN_TOKEN: TOKEN, PLAN_PAY_ADDRESS: PAY, START_BLOCK: "990",
    WATCHER_PRIVATE_KEY: generatePrivateKey(), ANTHROPIC_API_KEY: "test-key-not-real", FEED_URLS: "",
    CARD_VAULTS: LISTED, TELEGRAM_BOT_TOKEN: "1:test", TELEGRAM_WEBHOOK_SECRET: "w".repeat(20), BOT_MODE: "polling", LOOP_SCALE: "0.001",
  });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = () => {};
  current = (await import(`../src/index.ts?audit2=${tag}`)) as { stop: () => void };
}

const until = async (check: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(10);
  }
  return false;
};

describe("A2-L1: the watcher's scope check runs the full liveKeys query once per QUORUM detector, every pass", () => {
  async function seed(detectors: number) {
    await freshPg();
    const r = repo(db);
    await r.setPaidUntil(OWNER, 4_000_000_000);
    // 100 paid positions with 8 keys each: a modest book.
    for (let p = 0; p < 100; p++) {
      const keys = Array.from({ length: 8 }, (_, k) => `0x${(p * 8 + k + 1).toString(16).padStart(64, "0")}`);
      await r.upsertPosition({ posId: `0xe${(p + 1).toString(16).padStart(63, "0")}`, owner: OWNER, adapter: ADAPTER, target: LISTED.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys });
    }
    // Detectors anyone registered: AlarmBook only checks a QUORUM threshold, so the target can be any address.
    for (let i = 0; i < detectors; i++) {
      await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,5,$2,2,0,'0x','0x')`, [`0xd${(i + 1).toString(16).padStart(63, "0")}`, followed(i)]);
    }
  }

  async function firstPass(detectors: number, tag: string) {
    await seed(detectors);
    counting = { liveKeys: 0 };
    const t0 = performance.now();
    await boot("watcher", tag);
    const done = await until(() => counting.liveKeys >= detectors, 60_000);
    const ms = performance.now() - t0;
    current?.stop();
    return { done, ms, queries: counting.liveKeys };
  }

  test("2,000 detectors: 2,000 liveKeys queries before the first report is matched", async () => {
    const small = await firstPass(50, "w50");
    const big = await firstPass(2_000, "w2000");
    saved.console.log(`A2-L1: 50 detectors -> ${small.queries} liveKeys queries, ${small.ms.toFixed(0)} ms; 2,000 detectors -> ${big.queries} queries, ${big.ms.toFixed(0)} ms (in-process Postgres, 800 armed keys)`);
    expect(small.done && big.done).toBe(true);
    expect(big.queries).toBeGreaterThanOrEqual(2_000);
    expect(big.ms).toBeGreaterThan(small.ms * 5);
  }, 120_000);
});

describe("A2-M4: followed contracts are scanned before the listed vault, one at a time", () => {
  async function timeToListed(follows: number, tag: string) {
    await freshPg();
    const r = repo(db);
    slow = new Set();
    // One Telegram chat may follow 20 vaults; any number of chats may join in.
    for (let i = 0; i < follows; i++) {
      await r.follow(1 + Math.floor(i / 20), followed(i).toLowerCase());
      slow.add(followed(i).toLowerCase());
    }
    listedFirstRead = 0;
    const t0 = performance.now();
    await boot("detector", tag);
    const reached = await until(() => listedFirstRead > 0, 60_000);
    current?.stop();
    return reached ? listedFirstRead - t0 : Infinity;
  }

  test("40 followed contracts that answer in 50 ms hold the listed vault's first read back by seconds", async () => {
    rpcDelayMs = 50;
    const control = await timeToListed(0, "d0");
    const attacked = await timeToListed(40, "d40");
    saved.console.log(`A2-M4: listed vault first read after ${control.toFixed(0)} ms with no follows, ${attacked.toFixed(0)} ms behind 40 followed contracts (2 chats)`);
    // Each followed contract costs at least a getCode and a round of reads in each of the two loops before the listed one.
    expect(attacked).toBeGreaterThan(40 * rpcDelayMs);
    expect(attacked).toBeGreaterThan(control * 5);
  }, 120_000);
});
