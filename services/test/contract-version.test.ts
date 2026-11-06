// Every service reads a v2-only view from its configured contracts at startup and refuses to start unless they answer.
// The first group runs the check against a stand-in node through viem; the last starts src/index.ts as a process.
import { beforeEach, describe, expect, test } from "bun:test";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, type Abi, type Address, type Hex } from "viem";
import { alarmBookAbi, routerAbi } from "../src/chain/abi";
import { announceRefusal, ContractVersionError, requireV2 } from "../src/chain/version";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const ROUTER = "0x00000000000000000000000000000000000000b1" as Address;
const BOOK = "0x00000000000000000000000000000000000000b2" as Address;
const ALL = [...(routerAbi as Abi), ...(alarmBookAbi as Abi)] as Abi;

type Answer = "v2" | "revert" | "empty" | "down";
/** A node where each contract answers as v2, reverts (v1 has no such function), has no code, or is unreachable. */
function node(at: { router: Answer; book: Answer }) {
  const calls: string[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === "eth_chainId") return "0x1237";
    if (method !== "eth_call") throw new Error(`no ${method}`);
    const c = (params as [{ to: string; data?: Hex; input?: Hex }])[0];
    const { functionName } = decodeFunctionData({ abi: ALL, data: (c.data ?? c.input)! });
    calls.push(`${c.to.toLowerCase() === ROUTER ? "router" : "book"}.${functionName}`);
    const answer = c.to.toLowerCase() === ROUTER ? at.router : at.book;
    if (answer === "down") throw Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });
    if (answer === "revert") throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
    if (answer === "empty") return "0x";
    return encodeFunctionResult({ abi: ALL, functionName, result: 4n } as never);
  };
  return { client: createPublicClient({ transport: custom({ request } as never, { retryCount: 0 }) }), calls };
}

const noSleep = async () => {};

describe("the startup contract-version check", () => {
  test("v2 contracts answer MAX_SWAPS and REBASE_AFTER, and the service starts", async () => {
    const { client, calls } = node({ router: "v2", book: "v2" });
    await requireV2(client, { router: ROUTER, alarmBook: BOOK }, { sleep: noSleep });
    expect(calls.sort()).toEqual(["book.REBASE_AFTER", "router.MAX_SWAPS"]);
  });

  test("a router that reverts MAX_SWAPS (v1) is refused, and the message names it", async () => {
    const { client } = node({ router: "revert", book: "v2" });
    const e = await requireV2(client, { router: ROUTER, alarmBook: BOOK }, { sleep: noSleep }).catch((x) => x);
    expect(e).toBeInstanceOf(ContractVersionError);
    expect(e.kind).toBe("not-v2");
    expect(e.message).toContain(`ROUTER ${ROUTER} does not answer MAX_SWAPS()`);
    expect(e.message).not.toContain("ALARM_BOOK");
  });

  test("an AlarmBook that reverts REBASE_AFTER is refused", async () => {
    const { client } = node({ router: "v2", book: "revert" });
    const e = await requireV2(client, { router: ROUTER, alarmBook: BOOK }, { sleep: noSleep }).catch((x) => x);
    expect(e.kind).toBe("not-v2");
    expect(e.message).toContain(`ALARM_BOOK ${BOOK} does not answer REBASE_AFTER()`);
  });

  test("an address with no code is not v2, and both v1 contracts are named together", async () => {
    const { client } = node({ router: "empty", book: "revert" });
    const e = await requireV2(client, { router: ROUTER, alarmBook: BOOK }, { sleep: noSleep }).catch((x) => x);
    expect(e.kind).toBe("not-v2");
    expect(e.message).toContain("ROUTER");
    expect(e.message).toContain("ALARM_BOOK");
  });

  test("a node that does not answer is retried, then refused as unreadable rather than as v1", async () => {
    const { client, calls } = node({ router: "down", book: "v2" });
    const waits: number[] = [];
    const e = await requireV2(client, { router: ROUTER, alarmBook: BOOK }, { tries: 3, sleep: async (ms) => void waits.push(ms) }).catch((x) => x);
    expect(e).toBeInstanceOf(ContractVersionError);
    expect(e.kind).toBe("unreadable");
    expect(e.message).not.toContain("not the v2");
    expect(calls.filter((c) => c === "router.MAX_SWAPS")).toHaveLength(3);
    expect(waits).toEqual([2_000, 2_000]);
  });

  test("a v1 answer is final at once: no retries", async () => {
    const { client, calls } = node({ router: "revert", book: "revert" });
    await requireV2(client, { router: ROUTER, alarmBook: BOOK }, { sleep: noSleep }).catch(() => {});
    expect(calls).toHaveLength(2);
  });
});

describe("telling the operators", () => {
  let db: Db;
  let r: Repo;
  beforeEach(async () => {
    db = await freshDb();
    r = repo(db);
  });
  const err = new ContractVersionError("ROUTER 0xabc does not answer MAX_SWAPS(), so it is not the v2 ExitRouter. A service must run on the v2 contracts.", "not-v2");

  test("the alert is queued once and sent at once", async () => {
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) await announceRefusal(r, err, { router: ROUTER, alarmBook: BOOK }, async (t) => void sent.push(t), () => 1_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("refused to start");
    expect(sent[0]).toContain("MAX_SWAPS()");
  });

  test("if sending fails or hangs, the row stays queued for another service and the call still returns", async () => {
    await announceRefusal(r, err, { router: ROUTER, alarmBook: BOOK }, () => new Promise(() => {}), () => 1_000, 20);
    const due = await r.dueJobs("ops", 1_000);
    expect(due).toHaveLength(1);
    expect((due[0]!.payload as { text: string }).text).toContain("refused to start");
  });

  test("with no ops chat configured, the alert is only queued", async () => {
    await announceRefusal(r, err, { router: ROUTER, alarmBook: BOOK }, undefined, () => 1_000);
    expect(await r.dueJobs("ops", 1_000)).toHaveLength(1);
  });
});

describe("src/index.ts on v1 addresses", () => {
  const url = process.env.TEST_DATABASE_URL;
  // A process needs real Postgres: it migrates and reads the database as a deployed service does.
  (url ? test : test.skip)("exits non-zero, tells the ops chat, and leaves the database untouched even with CONTRACT_SWITCH set", async () => {
    const db = await freshDb();
    const telegram: string[] = [];
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname.includes("/sendMessage")) {
          telegram.push(String(((await req.json()) as { text: string }).text));
          return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } });
        }
        // Everything else is the node: every eth_call reverts, as v1 contracts do for the v2-only views.
        const body = (await req.json()) as { id: number; method: string };
        if (body.method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1237" });
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted" } });
      },
    });
    try {
      const root = `http://127.0.0.1:${stub.port}`;
      const proc = Bun.spawn([process.execPath, "src/index.ts"], {
        cwd: `${import.meta.dir}/..`,
        env: {
          PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ROLE: "indexer", PORT: "0", PUBLIC_URL: "https://api.example.test", DATABASE_URL: url!, CHAIN_ID: "4663",
          RPC_URL: root, RPC_URL_BACKUP: root, ROUTER, ALARM_BOOK: BOOK, ADAPTER_4626: ROUTER, PLAN_TOKEN: ROUTER, PLAN_PAY_ADDRESS: ROUTER, CONTRACT_SWITCH: ROUTER,
          TELEGRAM_BOT_TOKEN: "1:test", TELEGRAM_API_ROOT: root, TELEGRAM_WEBHOOK_SECRET: "s".repeat(20), OPS_CHAT_ID: "4242",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("contract version check failed");
      expect(code).toBe(1);
      expect(telegram.some((t) => t.includes("refused to start") && t.includes("MAX_SWAPS()"))).toBe(true);
      expect(await db.query(`SELECT 1 FROM meta`)).toHaveLength(0); // the switch never ran
    } finally {
      stub.stop(true);
    }
  }, 60_000);
});
