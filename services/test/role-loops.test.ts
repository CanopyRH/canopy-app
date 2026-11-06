// The watcher and detector loops of src/index.ts, loaded the way index.test.ts loads it: a stand-in chain answered in
// process, an in-process Postgres, and a bot whose Telegram calls are answered locally. Nothing opens a port.
//
// - The watcher's feed loop used to run the whole liveKeys query once per registered QUORUM detector, every pass.
//   Registering one is open to anyone, so the loop's cost grew as detectors x positions. Now it reads live keys once.
// - The detector role scanned followed contracts before listed vaults, one after another. Anyone can follow any
//   contract, so slow ones pushed back the scans that feed the watchers' on-chain signal. Now listed vaults go first,
//   in a loop of their own.
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
let counting = { liveKeys: 0, passes: 0 };
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
      if (s.includes("FROM feed_items WHERE at>")) counting.passes++; // the end of one feed pass
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
    // These tests seed a database with positions and no stored addresses; the operator authorises the move to these ones.
    CONTRACT_SWITCH: ROUTER,
    WATCHER_PRIVATE_KEY: generatePrivateKey(), ANTHROPIC_API_KEY: "test-key-not-real", FEED_URLS: "",
    CARD_VAULTS: LISTED, TELEGRAM_BOT_TOKEN: "1:test", TELEGRAM_WEBHOOK_SECRET: "w".repeat(20), BOT_MODE: "polling", LOOP_SCALE: "0.001",
  });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = () => {};
  current = (await import(`../src/index.ts?loops=${tag}`)) as { stop: () => void };
}

const until = async (check: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(10);
  }
  return false;
};

describe("the watcher's scope check", () => {
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

  test("2,000 detectors: one liveKeys query per pass, not one per detector", async () => {
    await seed(2_000);
    counting = { liveKeys: 0, passes: 0 };
    const t0 = performance.now();
    await boot("watcher", "w2000");
    const done = await until(() => counting.passes >= 3, 60_000);
    const ms = performance.now() - t0;
    const { liveKeys, passes } = counting;
    current?.stop();
    saved.console.log(`watcher scope: ${passes} passes, ${liveKeys} liveKeys queries, ${ms.toFixed(0)} ms for 3 passes over 2,000 detectors`);
    expect(done).toBe(true);
    // Before: 2,000 queries before the first pass could even match a report, about a minute here.
    expect(liveKeys).toBeLessThanOrEqual(passes + 1);
    expect(ms).toBeLessThan(15_000);
  }, 120_000);
});

describe("the detector role", () => {
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

  test("reads the listed vault first, however many slow contracts are followed", async () => {
    rpcDelayMs = 50;
    const control = await timeToListed(0, "d0");
    const attacked = await timeToListed(40, "d40");
    saved.console.log(`detector: listed vault first read after ${control.toFixed(0)} ms with no follows, ${attacked.toFixed(0)} ms with 40 slow followed contracts`);
    // Before: behind every followed contract, each costing a getCode and a round of reads, so over 40 x 50 ms.
    expect(attacked).toBeLessThan(5 * rpcDelayMs);
  }, 120_000);
});
