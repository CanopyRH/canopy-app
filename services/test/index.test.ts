import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, numberToHex, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { presetsFor } from "../src/api/presets";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import type { Db } from "../src/store/db";
import { repo } from "../src/store/repo";

/**
 * Loads src/index.ts the way a host starts it, with every role on, against a stand-in chain, a stand-in Telegram and an
 * in-process Postgres. What the log and the database say afterwards shows that the wiring between the pieces works.
 */

const ROUTER = "0x00000000000000000000000000000000000000d4" as Address;
const BOOK = "0x00000000000000000000000000000000000000d5" as Address;
const ADAPTER = "0x00000000000000000000000000000000000000d6" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d7" as Address;
const PAY = "0x00000000000000000000000000000000000000d8" as Address;
const CARD = "0x00000000000000000000000000000000000000d9" as Address;
const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
const PAYER = "0x00000000000000000000000000000000000000a2" as Address;
const LATE_PAYER = "0x00000000000000000000000000000000000000a3" as Address;
const VAULT = "0x00000000000000000000000000000000000000c3" as Address;
const POS = `0x${"11".repeat(32)}` as Hex;
// The vault's own "Vault loss" preset, so followers are told when it fires.
const PRESET = presetsFor(VAULT)[0]!;
const KEY = PRESET.key;
const TX = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;
const HEAD = 1_000n;
// Recent, so the keeper's own alarm-queue loop would also pick it up, whichever indexer loop reads first.
const FIRED_AT = BigInt(Math.floor(Date.now() / 1000) - 100);
const OPS_CHAT = 4242;
const HEALTH = "h".repeat(20);
const SECRET = "w".repeat(20);

type RpcLog = { address: Address; topics: Hex[]; data: Hex; block: bigint; tx: Hex; index: number };

function logOf(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>, block: bigint, tx: Hex, index = 0): RpcLog {
  const item = (abi as readonly { type: string; name?: string; inputs: readonly { name: string; type: string; indexed?: boolean }[] }[]).find((x) => x.type === "event" && x.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]])) } as never);
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never) : "0x";
  return { address, topics: topics as Hex[], data, block, tx, index };
}

const LOGS: RpcLog[] = [
  logOf(ROUTER, routerAbi as Abi, "ArmingPaused", { paused: true }, 995n, TX(1)),
  logOf(ROUTER, routerAbi as Abi, "Armed", { posId: POS, owner: OWNER, adapter: ADAPTER, target: VAULT, tokenId: 0n, harbour: 0, maxSlipBps: 0, termsHash: TX(9), keys: [KEY] }, 996n, TX(2)),
  logOf(BOOK, alarmBookAbi as Abi, "WatcherSet", { watcher: PAYER, since: 1_000n, until: 2_000n }, 994n, TX(3)),
  logOf(BOOK, alarmBookAbi as Abi, "Registered", { key: KEY, kind: PRESET.detector.kind, target: VAULT, threshold: PRESET.detector.threshold, window: PRESET.detector.window, a: PRESET.detector.a, b: PRESET.detector.b }, 995n, TX(4)),
  logOf(BOOK, alarmBookAbi as Abi, "Fired", { key: KEY, kind: PRESET.detector.kind, target: VAULT, by: OWNER, evidence: TX(8) }, 997n, TX(5)),
  // 990 is deep enough under a depth of 2. 999 is not.
  logOf(TOKEN, erc20Abi as Abi, "Transfer", { from: PAYER, to: PAY, value: 15_000_000n }, 990n, TX(6)),
  logOf(TOKEN, erc20Abi as Abi, "Transfer", { from: LATE_PAYER, to: PAY, value: 15_000_000n }, 999n, TX(7)),
];

const rpcLog = (l: RpcLog) => ({
  address: l.address, topics: l.topics, data: l.data, blockNumber: numberToHex(l.block), blockHash: `0x${l.block.toString(16).padStart(64, "0")}`, transactionHash: l.tx, transactionIndex: "0x0", logIndex: numberToHex(l.index), removed: false,
});

function callResult(to: string, data: Hex): Hex {
  const all = [...(routerAbi as Abi), ...(alarmBookAbi as Abi)] as Abi;
  const { functionName } = decodeFunctionData({ abi: all, data });
  // The startup version check: only v2 contracts have these.
  if (functionName === "MAX_SWAPS") return encodeFunctionResult({ abi: routerAbi as Abi, functionName: "MAX_SWAPS", result: 4n });
  if (functionName === "REBASE_AFTER") return encodeFunctionResult({ abi: alarmBookAbi as Abi, functionName: "REBASE_AFTER", result: 604_800n });
  if (functionName === "isArmed") return encodeFunctionResult({ abi: routerAbi as Abi, functionName: "isArmed", result: true });
  if (functionName === "state") return encodeFunctionResult({ abi: alarmBookAbi as Abi, functionName: "state", result: [true, FIRED_AT, 0n, 0n, 0n, 0n, 0n, 0n] });
  throw new Error(`reverted ${functionName} on ${to}`);
}

function answer(method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_chainId": return "0x1237";
    case "eth_blockNumber": return numberToHex(HEAD);
    case "eth_getBlockByNumber": {
      // The indexer remembers block hashes, to notice a reorg. This chain never reorgs, so a hash is just the number.
      const n = BigInt(params[0] as Hex);
      if (n > HEAD) return null;
      return { number: numberToHex(n), hash: `0x${n.toString(16).padStart(64, "0")}`, parentHash: `0x${"00".repeat(32)}`, timestamp: "0x1", transactions: [] };
    }
    case "eth_getBalance": return "0xde0b6b3a7640000";
    case "eth_getCode": return "0x";
    case "eth_getTransactionCount": return "0x0";
    case "eth_getLogs": {
      const f = params[0] as { address: string | string[]; fromBlock: Hex; toBlock: Hex };
      const wanted = ([] as string[]).concat(f.address).map((a) => a.toLowerCase());
      return LOGS.filter((l) => wanted.includes(l.address.toLowerCase()) && l.block >= BigInt(f.fromBlock) && l.block <= BigInt(f.toBlock)).map(rpcLog);
    }
    case "eth_call": {
      const c = params[0] as { to: string; data?: Hex; input?: Hex };
      return callResult(c.to, (c.data ?? c.input)!);
    }
    default: throw new Error(`no ${method}`);
  }
}

const sent: { method: string; body: Record<string, unknown> }[] = [];
let db: Db;
let indexModule: typeof import("../src/index");
let restoreModules: () => void = () => {};
let web: { fetch: (r: Request) => Response | Promise<Response> };
const saved = { env: { ...process.env }, console: { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }, fetch: globalThis.fetch, serve: Bun.serve };

/** The stand-in chain, answering JSON-RPC (single or batched) the way a node would. */
async function rpcNode(req: Request) {
  const one = (m: { id: number; method: string; params: unknown[] }) => {
    try {
      return { jsonrpc: "2.0", id: m.id, result: answer(m.method, m.params ?? []) };
    } catch (e) {
      return { jsonrpc: "2.0", id: m.id, error: { code: 3, message: `execution reverted: ${(e as Error).message}` } };
    }
  };
  const body = (await req.json()) as never;
  return Response.json(Array.isArray(body) ? (body as never[]).map(one) : one(body));
}

/** The stand-in Telegram: an API transformer on the bot answers every call itself and records it. */
const telegramApi = async (_prev: unknown, method: string, payload: Record<string, unknown>) => {
  sent.push({ method, body: payload });
  const result = method === "getMe"
    ? { id: 1, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }
    : { message_id: 1, date: 0, chat: { id: 1, type: "private" } };
  return { ok: true as const, result };
};

const until = async (check: () => Promise<boolean> | boolean, what: string, ms = 8_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const get = (path: string, headers: Record<string, string> = {}) => web.fetch(new Request(`https://api.example.test${path}`, { headers }));
const rows = <T>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);

beforeAll(async () => {
  // Nothing here opens a port: the chain and Telegram are answered in-process, and the web server is captured, not started.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const host = new URL(req.url).host;
    if (host === "rpc.test") return rpcNode(req);
    return saved.fetch(input, init);
  }) as never;
  Bun.serve = ((o: { fetch: (r: Request, s?: unknown) => Response | Promise<Response> }) => {
    web = { fetch: (r) => o.fetch(r) };
    return { port: 0, stop() {}, fetch: web.fetch };
  }) as never;

  const pg = new PGlite();
  db = { query: async (s, p = []) => (await pg.query(s, p as never[])).rows as never, exec: async (s) => void (await pg.exec(s)) };
  // A mocked module also replaces the bindings of the original, so the real functions are kept first.
  const real = { ...(await import("../src/store/db")) };
  mock.module("../src/store/db", () => ({ ...real, postgres: (url: string, max?: number) => (url.startsWith("pglite:") ? db : real.postgres(url, max)) }));
  const realBot = { ...(await import("../src/bot/bot")) };
  mock.module("../src/bot/bot", () => ({
    ...realBot,
    createBot: (...a: Parameters<typeof realBot.createBot>) => {
      const bot = realBot.createBot(...a);
      if (a[0] === "1:test") bot.api.config.use(telegramApi as never);
      return bot;
    },
  }));
  restoreModules = () => {
    mock.module("../src/store/db", () => real);
    mock.module("../src/bot/bot", () => realBot);
  };
  await real.migrate(db);
  await repo(db).follow(55, VAULT.toLowerCase());
  await repo(db).saveCard(CARD.toLowerCase(), { name: "Demo vault", assetSymbol: "USDC" }, "card text", 1);

  Object.assign(process.env, {
    ROLE: "all", PORT: "0", PUBLIC_URL: "https://api.example.test", APP_URL: "https://app.example.test", DATABASE_URL: "pglite://memory", CHAIN_ID: "4663",
    RPC_URL: "http://rpc.test/a", RPC_URL_BACKUP: "http://rpc.test/b",
    ROUTER, ALARM_BOOK: BOOK, ADAPTER_4626: ADAPTER, PLAN_TOKEN: TOKEN, PLAN_PAY_ADDRESS: PAY, START_BLOCK: "990", CONFIRMATIONS: "2",
    KEEPER_PRIVATE_KEY: generatePrivateKey(), KEEPER_PAID_ONLY: "false", WATCHER_PRIVATE_KEY: generatePrivateKey(), ANTHROPIC_API_KEY: "test-key-not-real",
    CARD_VAULTS: CARD, TELEGRAM_BOT_TOKEN: "1:test", TELEGRAM_WEBHOOK_SECRET: SECRET,
    BOT_MODE: "webhook", LOOP_SCALE: "0.01", OPS_CHAT_ID: String(OPS_CHAT), HEALTH_TOKEN: HEALTH,
  });
  // The loops report every failed pass, and a stand-in chain fails plenty. The assertions below read the database instead.
  for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = () => {};
  indexModule = await import("../src/index");
});

afterAll(() => {
  indexModule?.stop();
  restoreModules();
  globalThis.fetch = saved.fetch;
  Bun.serve = saved.serve;
  Object.assign(console, saved.console);
  for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
  Object.assign(process.env, saved.env);
});

describe("src/index.ts, every role on", () => {
  test("serves the listed vaults from the saved risk cards", async () => {
    const res = await get("/vaults");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ address: CARD.toLowerCase(), name: "Demo vault", asset: "USDC", chainId: 4663 }]);
    expect((await get("/alarms/live")).status).toBe(200);
    expect((await get("/presets/" + VAULT)).status).toBe(200);
  });

  test("/health needs its token and reports the chain head", async () => {
    expect((await get("/health")).status).toBe(403);
    await until(async () => (await rows(`SELECT 1 FROM cursors WHERE name LIKE 'router@%'`)).length > 0, "the router cursor");
    const res = await get("/health", { authorization: `Bearer ${HEALTH}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chainId: number; tip: string; lagBlocks: number; retryingLogs: number };
    expect(body).toMatchObject({ chainId: 4663, tip: "1000", retryingLogs: 0 });
    expect(body.lagBlocks).toBeLessThanOrEqual(1);
  });

  test("an admin event on the router reaches the operator chat with a link", async () => {
    await until(() => sent.some((m) => m.method === "sendMessage" && String(m.body.text).includes("ArmingPaused")), "the operator message");
    const m = sent.find((x) => x.method === "sendMessage" && String(x.body.text).includes("ArmingPaused"))!;
    expect(m.body.chat_id).toBe(OPS_CHAT);
    expect(String(m.body.text)).toContain(`https://robinhoodchain.blockscout.com/tx/${TX(1)}`);
    expect(String(m.body.text)).toContain("paused=true");
  });

  test("a watcher change on the AlarmBook reaches the operator chat", async () => {
    await until(() => sent.some((m) => String(m.body.text).includes("WatcherSet")), "the watcher message");
    const texts = sent.filter((m) => m.method === "sendMessage" && String(m.body.text).includes("WatcherSet"));
    expect(texts).toHaveLength(1); // read again on every pass, told once
  });

  test("an arm is applied at once, then confirmed against the router once it is deep", async () => {
    await until(async () => (await rows<{ confirmed: boolean; active: boolean }>(`SELECT confirmed, active FROM positions WHERE pos_id=$1`, [POS]))[0]?.confirmed === true, "the arm to be confirmed");
    expect((await rows<{ active: boolean }>(`SELECT active FROM positions`))[0]!.active).toBe(true);
  });

  test("a registered detector, a fired alarm and its exit job are recorded", async () => {
    await until(async () => (await rows(`SELECT 1 FROM alarms WHERE key=$1`, [KEY])).length > 0, "the alarm");
    expect((await rows<{ kind: number }>(`SELECT kind FROM detectors WHERE key=$1`, [KEY]))[0]!.kind).toBe(1);
    await until(async () => (await rows(`SELECT 1 FROM jobs WHERE kind='exit'`)).length > 0, "the exit job");
  });

  test("a follower of the vault is told when its own preset fires, with the evidence link", async () => {
    await until(() => sent.some((m) => m.method === "sendMessage" && m.body.chat_id === 55), "the follower alert");
    const m = sent.find((x) => x.method === "sendMessage" && x.body.chat_id === 55)!;
    expect(String(m.body.text)).toContain(`https://robinhoodchain.blockscout.com/tx/${TX(5)}`);
    expect(sent.filter((x) => x.body.chat_id === 55 && String(x.body.text).includes(TX(5)))).toHaveLength(1);
  });

  test("a plan payment is credited once it is deep enough, and a newer one is not", async () => {
    await until(async () => (await repo(db).paidUntil(PAYER.toLowerCase())) !== null, "the credit");
    await until(async () => ((await repo(db).cursor("payments")) ?? 0n) >= 999n, "the payments cursor");
    expect(await repo(db).paidUntil(LATE_PAYER.toLowerCase())).toBeNull();
  });

  test("the Telegram webhook refuses a wrong secret and answers /start through the bot", async () => {
    const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 77, type: "private" }, from: { id: 77, is_bot: false, first_name: "T" }, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] } };
    const post = (secret: string) => web.fetch(new Request("https://api.example.test/tg/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" }, body: JSON.stringify(update) }));
    expect((await post("wrong-secret-wrong-secret")).status).toBe(403);
    expect((await post(SECRET)).status).toBe(200);
    expect(sent.some((m) => m.method === "sendMessage" && m.body.chat_id === 77)).toBe(true);
  });

  test("the keeper account is funded and its gas is recorded for the operator", async () => {
    await until(async () => (await rows(`SELECT 1 FROM counters WHERE name='keeper_gas_wei'`)).length > 0, "the gas counter");
  });
});
