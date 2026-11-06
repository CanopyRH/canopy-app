// Re-runs of the first service audit's PoCs against the current code, and the leads closed after the second: secrets in
// any URL or logged object, tables that only grew, an unpaged /alarms/live, and an alarm queue that reread the whole day.
// Local mocks and the in-process database only.
import { beforeEach, describe, expect, test } from "bun:test";
import { createPublicClient, encodeFunctionResult, fallback, http, type Address, type Hex } from "viem";
import { Kind, keyOf, presetsFor } from "../src/api/presets";
import { queueAlert } from "../src/bot/queue";
import { erc20Abi } from "../src/chain/abi";
import { createApi } from "../src/api/server";
import { ALARM_SWEEP_SEC, drainExits, queueNewAlarms, type AlarmCursor, type ExitJob, type KeeperDeps } from "../src/keeper/keeper";
import { scrubConsole, scrubUrls } from "../src/log";
import type { Db } from "../src/store/db";
import { PRUNE_KEEP, repo, type Repo } from "../src/store/repo";
import { quorumScope } from "../src/watcher/scope";
import { freshDb } from "./db";
import { enqueueExit } from "./jobs";

const X = "0x00000000000000000000000000000000000000e1" as Address; // attacker's "vault"
const ADAPTER = "0x00000000000000000000000000000000000000e2" as Address;
const V = "0x00000000000000000000000000000000000000c3" as Address; // a real vault with a victim's position
const ROUTER = "0x00000000000000000000000000000000000000b0" as Address;
const KEEPER = "0x00000000000000000000000000000000000000a0" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address;
const TX = `0x${"11".repeat(32)}` as Hex;
const bal = (v: bigint) => encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: v });

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

describe("H-1 re-run: a vault whose adapter claims 2^255 markets", () => {
  for (const listed of [new Set([V.toLowerCase()]), new Set<string>()]) {
    test(`drainExits finishes and the victim's exit is sent (listed set ${listed.size ? "set" : "empty, every vault deallocates"})`, async () => {
      let reads = 0;
      let victimLeft = 100n;
      const sentTo: string[] = [];
      const client = {
        readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          reads++;
          await Bun.sleep(0);
          switch (functionName) {
            case "balanceOf": case "allowance": return address === V ? victimLeft : 100n;
            case "asset": return TOKEN;
            case "liquidityAdapter": if (address === X) return ADAPTER; throw new Error("not v2");
            case "forceDeallocatePenalty": return 0n;
            case "marketIdsLength": return 2n ** 255n;
            case "marketIds": return `0x${"77".repeat(32)}`;
            case "market": return [0n, 0n, 0n, 0n, 0n, 0n];
            case "position": return [0n, 0n, 0n];
            default: throw new Error(functionName);
          }
        },
        // The gate passes for the victim's exit; the attacker's never simulates cleanly.
        simulateCalls: async ({ calls }: { calls: { to: Address }[] }) => {
          const exitAt = calls.findIndex((c) => c.to === ROUTER);
          return { results: calls.map((_, i) => (i === exitAt ? { status: "success", data: "0x", gasUsed: 300_000n } : { status: "success", data: bal(i === exitAt + 1 ? 1n : 0n), gasUsed: 1n })) };
        },
      };
      const d = {
        client, repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: ROUTER, morpho: ROUTER, account: KEEPER, now: () => 1_000, paidOnly: true, listed,
        send: async (tx: { to: string }) => {
          sentTo.push(tx.to);
          victimLeft = 0n;
          return TX;
        },
      } as unknown as KeeperDeps;
      const attackerJob: ExitJob = { posId: `0x${"01".repeat(32)}`, key: `0x${"a1".repeat(32)}`, owner: KEEPER, target: X, firedAt: 990 };
      const victimJob: ExitJob = { posId: `0x${"02".repeat(32)}`, key: presetsFor(V)[0]!.key, owner: KEEPER, target: V, firedAt: 995 };
      await enqueueExit(r, "attacker", attackerJob, 990);
      await enqueueExit(r, "victim", victimJob, 995);
      const outcome = await Promise.race([drainExits(d).then(() => "finished"), Bun.sleep(3_000).then(() => "still running")]);
      expect(outcome).toBe("finished");
      expect(sentTo.length).toBeGreaterThanOrEqual(1);
      expect(reads).toBeLessThan(100);
    });
  }
});

describe("L-2 re-run: the alarm handler only writes a row", () => {
  test("queueing an alert costs the same with 300 followers as with none", async () => {
    for (let chat = 1; chat <= 300; chat++) await r.follow(chat, X);
    const t0 = performance.now();
    await queueAlert(r, X, "alarm text", 100);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(await r.dueJobs("alert", 100)).toHaveLength(1);
  });
});

describe("L-3 re-run: an attacker's QUORUM key on its own contract", () => {
  const key = keyOf({ kind: Kind.QUORUM, target: X, threshold: 2n, window: 0, a: `0x${"00".repeat(31)}01` as Hex, b: `0x${"00".repeat(32)}` as Hex });
  const arm = (owner: string) =>
    r.upsertPosition({ posId: `0x${"0e".repeat(32)}`, owner, adapter: ADAPTER, target: X, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "x", keys: [key] });

  test("is out of scope when armed from an unpaid wallet", async () => {
    await arm("0xunpaid");
    expect(await quorumScope(r, [V.toLowerCase()], () => 100, true)(key, X)).toBe(false);
  });

  test("residual: comes back into scope once the attacker buys one plan", async () => {
    await arm("0xpaid");
    await r.setPaidUntil("0xpaid", 10_000);
    expect(await quorumScope(r, [V.toLowerCase()], () => 100, true)(key, X)).toBe(true);
  });
});

describe("L-4 re-run: an RPC key in the URL path", () => {
  test("viem still puts it in the message, and the scrubbed console drops it", async () => {
    const transport = fallback([http("http://127.0.0.1:9/robinhood/SECRET_PATH_KEY", { retryCount: 0 }), http("http://127.0.0.1:9/backup/SECRET_PATH_KEY", { retryCount: 0 })]);
    const msg = await createPublicClient({ transport }).getBlockNumber().then(() => "", (e) => (e as Error).message);
    expect(msg).toContain("SECRET_PATH_KEY");

    const original = { ...console };
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      scrubConsole();
      console.error("exits", msg);
      console.warn("poke", new Error(msg));
    } finally {
      Object.assign(console, original);
    }
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("SECRET_PATH_KEY");
    expect(lines.join("\n")).toContain("http://127.0.0.1:9/…");
  });
});

describe("log scrubbing", () => {
  test("any scheme's URL loses its credentials and path, and an object is scrubbed before it is printed", () => {
    expect(scrubUrls("connect postgres://canopy:hunter2-secret@db.example.com:5432/canopy?sslmode=require failed")).toBe("connect postgres://db.example.com:5432/… failed");
    expect(scrubUrls("redis://:pw-secret@cache.example.com:6379/0")).toBe("redis://cache.example.com:6379/…");
    expect(scrubUrls("postgresql://u:pa/ss#x@db.example.com/canopy")).toBe("postgresql://db.example.com/…");

    const original = { ...console };
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      scrubConsole();
      console.error("db", { url: "postgres://canopy:hunter2-secret@db.example.com/canopy", nested: { rpc: "https://rpc.example.org/v1/SECRET_PATH_KEY" } });
    } finally {
      Object.assign(console, original);
    }
    expect(lines.join("\n")).not.toContain("hunter2-secret");
    expect(lines.join("\n")).not.toContain("SECRET_PATH_KEY");
    expect(lines.join("\n")).toContain("db.example.com");
  });
});

describe("tables that only grew", () => {
  test("old done jobs, alarms, signals, attestations, reports, alert claims and readings are pruned; live rows stay", async () => {
    const now = 100 * 86_400;
    const old = (keep: number) => now - keep - 1;
    const fresh = now - 60;
    for (const [id, at, done] of [["a", old(PRUNE_KEEP.jobs), true], ["b", fresh, true], ["c", old(PRUNE_KEEP.jobs), false]] as const) {
      await db.query(`INSERT INTO jobs (kind, dedupe, payload, run_at, created_at, done) VALUES ('exit',$1,'{}',$2,$2,$3)`, [id, at, done]);
    }
    for (const at of [old(PRUNE_KEEP.alarms), fresh]) await r.recordAlarm(`0x${"aa".repeat(32)}`, at, null, "");
    for (const at of [old(PRUNE_KEEP.signals), fresh]) await r.recordSignal({ kind: "DRAIN", target: V, severity: "soft", value: 1, evidence: "", at });
    for (const [d, s] of [[old(PRUNE_KEEP.attestations), "a"], [fresh, "b"]] as const) await db.query(`INSERT INTO attestations (key, evidence_hash, deadline, signer, sig) VALUES ('k','e',$1,$2,'0x')`, [d, s]);
    for (const [h, at] of [["old", old(PRUNE_KEEP.feedItems)], ["new", fresh]] as const) await db.query(`INSERT INTO feed_items (sha256, source_url, raw, at) VALUES ($1,'u','t',$2)`, [h, at]);
    await r.claimAlert(V, "old", old(PRUNE_KEEP.sentAlerts));
    await r.claimAlert(V, "new", fresh);
    for (const t of [old(PRUNE_KEEP.snaps), fresh]) await r.recordSnap(V, t, 1n, 1n);

    await r.prune(now);
    const count = async (table: string) => Number((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`))[0]!.n);
    expect((await db.query<{ dedupe: string }>(`SELECT dedupe FROM jobs ORDER BY dedupe`)).map((x) => x.dedupe)).toEqual(["b", "c"]);
    for (const table of ["alarms", "signals", "attestations", "feed_items", "sent_alerts", "vault_snaps"]) expect([table, await count(table)]).toEqual([table, 1]);
  });
});

describe("/alarms/live", () => {
  const key = (i: number) => `0x${i.toString(16).padStart(64, "0")}`;

  test("with no parameters it is the same plain array of the day's alarms; with a limit it pages, newest first", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) await r.recordAlarm(key(i), now - 100 + (i < 2 ? 0 : i), `0x${i}`, "");
    await r.recordAlarm(key(9), now - 2 * 86_400, null, ""); // a day old: not live
    const app = createApi({ db, repo: r, vaults: async () => [], watchers: [], alarmBook: ROUTER, chainId: 4663, now: () => now, liveAlarms: (p) => r.liveAlarms(now - 86_400, p.limit, p.before) });
    const get = (q = "") => app.fetch(new Request(`https://api.example.test/alarms/live${q}`));

    const all = (await (await get()).json()) as { key: string; fired_at: number }[];
    expect(all).toHaveLength(5);
    expect(all.map((a) => a.fired_at)).toEqual([...all.map((a) => a.fired_at)].sort((a, b) => b - a));

    const seen: string[] = [];
    let q = "?limit=2";
    for (;;) {
      const res = await get(q);
      seen.push(...((await res.json()) as { key: string }[]).map((a) => a.key));
      const next = res.headers.get("x-next-before");
      if (!next) break;
      q = `?limit=2&before=${next}`;
    }
    // Two alarms share a time, and the cursor still lists each once.
    expect(seen).toEqual(all.map((a) => a.key));
    expect((await get("?before=nonsense")).status).toBe(400);
  });
});

describe("the keeper's alarm queue loop", () => {
  test("a quiet pass reads only new alarms, and the whole day once a minute", async () => {
    const OWNER = "0xabababababababababababababababababababab";
    await r.setPaidUntil(OWNER, 10_000_000);
    const k1 = `0x${"a1".repeat(32)}`;
    const k2 = `0x${"b2".repeat(32)}`;
    for (const [pos, k] of [["01", k1], ["02", k2]]) {
      await r.upsertPosition({ posId: `0x${pos!.repeat(32)}`, owner: OWNER, adapter: ROUTER, target: V, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [k!] });
    }
    let now = 10_000;
    let armedReads = 0;
    const counted = { ...r, armedWith: async (k: string) => (armedReads++, r.armedWith(k)) } as Repo;
    const d = { repo: counted, paidOnly: true, now: () => now } as unknown as KeeperDeps;
    const c: AlarmCursor = { seq: 0n, sweptAt: 0 };

    await r.recordAlarm(k1, now - 10, null, "");
    await queueNewAlarms(d, c); // the first pass sweeps the day
    expect(armedReads).toBe(1);
    for (let i = 0; i < 10; i++) {
      now += 2;
      await queueNewAlarms(d, c);
    }
    // Before: the whole day's alarms on every 2-second pass.
    expect(armedReads).toBe(1);
    await r.recordAlarm(k2, now, null, "");
    now += 2;
    await queueNewAlarms(d, c);
    expect(armedReads).toBe(2);
    expect(await r.dueJobs("exit", now)).toHaveLength(2);
    now = 10_000 + ALARM_SWEEP_SEC;
    await queueNewAlarms(d, c);
    expect(armedReads).toBe(4);
  });
});
