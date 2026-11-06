import { beforeEach, describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { createApi } from "../src/api/server";
import { adminAlertId, adminAlertText } from "../src/indexer/admin";
import { queueOps } from "../src/bot/queue";
import status, { gasState, parseAdminAlert } from "../src/plugins/status";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const BOOK = "0x0000000000000000000000000000000000000001" as Address;
const W1 = "0x00000000000000000000000000000000000000a1" as Address;
const W2 = "0x00000000000000000000000000000000000000a2" as Address;
const KEEPER = "0x00000000000000000000000000000000000000ee";
const TX = `0x${"ab".repeat(32)}`;
const NOW = 2_000_000;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

function api(over: { health?: () => Promise<unknown>; clock?: { t: number }; limit?: number } = {}) {
  const clock = over.clock ?? { t: NOW };
  const app = createApi({
    db, repo: r, vaults: async () => [], liveAlarms: async () => [], watchers: [W1, W2], alarmBook: BOOK, chainId: 4663, now: () => clock.t,
    health: over.health ?? (async () => ({ chainId: 4663, tip: "100", lagBlocks: 3, counters: { keeper_gas_wei: "9000000000000000" } })),
    healthToken: "h".repeat(16), plugins: [status], rateLimit: { perMin: over.limit ?? 1000, proxyHops: 1 },
  });
  return { app, clock, get: async () => (await app.request("/status", { headers: { "x-forwarded-for": "9.9.9.9" } })).json() as Promise<any> };
}

// The router emits GuardianSet(guardian); a real log would be decoded by adminEventOf, so build the alert the way the indexer does.
const guardianEvent = {
  contract: "ExitRouter" as const, event: "GuardianSet", args: [["guardian", W1]] as [string, string][], tx: TX as `0x${string}`, logIndex: 4, block: 777n,
};

describe("GET /status", () => {
  test("an empty database answers with unknowns and zeros, not errors", async () => {
    const { get } = api();
    const s = await get();
    expect(s.keeper).toEqual({ lastActedAt: null, gas: "healthy", queueDepth: 0, oldestQueuedSec: 0 });
    expect(s.indexer).toEqual({ lagBlocks: 3, state: "ok" });
    expect(s.alarmChecks.lastCheckedAt).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.alarmFirings.total).toBe(0);
    expect(s.alarmFirings.byDay).toHaveLength(7);
    expect(s.watchers.list).toEqual([
      { address: W1, lastAttestedAt: null },
      { address: W2, lastAttestedAt: null },
    ]);
  });

  test("keeper: last action, queue depth and gas level", async () => {
    await db.query(`INSERT INTO jobs (kind, dedupe, payload, run_at, created_at, done) VALUES ('exit','a','{}'::jsonb,1,$1,true),('exit','b','{}'::jsonb,1,$2,true),('exit','c','{}'::jsonb,1,$3,false),('exit','d','{}'::jsonb,1,$4,false),('alert','e','{}'::jsonb,1,$4,false)`, [NOW - 5000, NOW - 900, NOW - 300, NOW - 60]);
    const { get } = api();
    const k = (await get()).keeper;
    expect(k.lastActedAt).toBe(NOW - 900);
    expect(k.queueDepth).toBe(2);
    expect(k.oldestQueuedSec).toBe(300);
    expect(gasState(null, 500n)).toBe("unknown");
    expect(gasState(0n, 500n)).toBe("empty");
    expect(gasState(50n, 500n)).toBe("empty");
    expect(gasState(51n, 500n)).toBe("low");
    expect(gasState(499n, 500n)).toBe("low");
    expect(gasState(500n, 500n)).toBe("healthy");
    for (const [wei, want] of [["0", "empty"], ["100000000000000", "low"], ["9000000000000000", "healthy"]] as const) {
      const out = await api({ health: async () => ({ lagBlocks: 0, counters: { keeper_gas_wei: wei } }) }).get();
      expect(out.keeper.gas).toBe(want);
    }
    expect((await api({ health: async () => ({ lagBlocks: 0, counters: {} }) }).get()).keeper.gas).toBe("unknown");
  });

  test("indexer: lag in blocks, behind past the ops limit, unknown when the chain does not answer", async () => {
    expect((await api({ health: async () => ({ lagBlocks: 5000 }) }).get()).indexer).toEqual({ lagBlocks: 5000, state: "behind" });
    expect((await api({ health: async () => ({ lagBlocks: null }) }).get()).indexer).toEqual({ lagBlocks: null, state: "unknown" });
    const down = await api({ health: async () => { throw new Error("rpc down at http://secret-rpc.example"); } }).get();
    expect(down.indexer).toEqual({ lagBlocks: null, state: "unknown" });
    expect(JSON.stringify(down)).not.toContain("secret-rpc");
  });

  test("watchers: each approved watcher's last attestation, and never a signer who is not approved", async () => {
    const deadline = (windowStart: number) => windowStart + 1200;
    const add = (signer: string, d: number) => db.query(`INSERT INTO attestations (key, evidence_hash, deadline, signer, sig) VALUES ($1,'e',$2,$3,'0x')`, [`k${d}${signer}`, d, signer]);
    await add(W1, deadline(NOW - 4200));
    await add(W1, deadline(NOW - 1800)); // newer one wins
    await add("0x00000000000000000000000000000000000000ff", deadline(NOW - 600));
    const s = await api().get();
    expect(s.watchers.approved).toBe(2);
    expect(s.watchers.list).toEqual([
      { address: W1, lastAttestedAt: NOW - 1800 },
      { address: W2, lastAttestedAt: null },
    ]);
  });

  test("alarm checks: the newest vault snapshot", async () => {
    await r.recordSnap("0x00000000000000000000000000000000000000c1", NOW - 600, 5n, 1n);
    await r.recordSnap("0x00000000000000000000000000000000000000c2", NOW - 120, 5n, 1n);
    expect((await api().get()).alarmChecks.lastCheckedAt).toBe(NOW - 120);
  });

  test("history: admin alerts the indexer queued, newest first, each with an explorer link; other jobs stay out", async () => {
    await queueOps(r, adminAlertId(guardianEvent), adminAlertText(4663, guardianEvent), NOW - 3600);
    const later = { ...guardianEvent, event: "ArmingPaused", tx: `0x${"cd".repeat(32)}` as `0x${string}`, logIndex: 1, block: 800n };
    await queueOps(r, adminAlertId(later), adminAlertText(4663, later), NOW - 60);
    await queueOps(r, "stuck:something", "Canopy ops: a log is stuck.", NOW - 10);
    const { history } = await api().get();
    expect(history).toEqual([
      { event: "ArmingPaused", contract: "ExitRouter", block: 800, tx: later.tx, at: NOW - 60, txUrl: `https://robinhoodchain.blockscout.com/tx/${later.tx}` },
      { event: "GuardianSet", contract: "ExitRouter", block: 777, tx: TX, at: NOW - 3600, txUrl: `https://robinhoodchain.blockscout.com/tx/${TX}` },
    ]);
  });

  test("the admin alert parser follows the indexer's own wording", () => {
    expect(parseAdminAlert(`ops:${adminAlertId(guardianEvent)}`, adminAlertText(4663, guardianEvent))).toEqual({ event: "GuardianSet", contract: "ExitRouter", block: 777, tx: TX });
    expect(parseAdminAlert("ops:stuck:x", adminAlertText(4663, guardianEvent))).toBeNull();
    expect(parseAdminAlert(`ops:${adminAlertId(guardianEvent)}`, "something else")).toBeNull();
  });

  test("alarm firings: the last 7 days only, counted per day", async () => {
    const fire = (key: string, ago: number) => r.recordAlarm(key, NOW - ago, TX, "e");
    await fire("0x01", 100);
    await fire("0x02", 200);
    await fire("0x03", 86_400 + 5);
    await fire("0x04", 6 * 86_400 + 10);
    await fire("0x05", 7 * 86_400 + 10); // older than a week
    const f = (await api().get()).alarmFirings;
    expect(f.total).toBe(4);
    expect(f.byDay.map((d: { count: number }) => d.count)).toEqual([2, 1, 0, 0, 0, 0, 1]);
    expect(f.recent.map((a: { key: string }) => a.key)).toEqual(["0x01", "0x02", "0x03", "0x04"]);
    expect(f.recent[0].txUrl).toBe(`https://robinhoodchain.blockscout.com/tx/${TX}`);
  });

  test("exposes only safe fields: no keeper address, counters, cursors, or the raw health answer", async () => {
    await r.setCounter("keeper_gas_wei", 1n);
    const body = JSON.stringify(
      await api({
        health: async () => ({ keeperAddress: KEEPER, tip: "1", lagBlocks: 1, counters: { keeper_gas_wei: "9000000000000000", poke_ok: "4" }, cursors: { router: "5" }, openJobs: 9, watchersSeen7d: 2 }),
      }).get(),
    );
    for (const leak of [KEEPER, "keeperAddress", "9000000000000000", "poke_ok", "cursors", "openJobs", "counters", "tip"]) expect(body).not.toContain(leak);
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(["alarmChecks", "alarmFirings", "generatedAt", "history", "indexer", "keeper", "watchers"]);
  });

  test("/health stays token-protected and unchanged", async () => {
    const { app } = api();
    expect((await app.request("/health")).status).toBe(403);
    const ok = await app.request("/health", { headers: { authorization: `Bearer ${"h".repeat(16)}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ lagBlocks: 3, counters: { keeper_gas_wei: "9000000000000000" } });
  });

  test("sits under the public read rate limit", async () => {
    const { app } = api({ limit: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.request("/status", { headers: { "x-forwarded-for": "7.7.7.7" } })).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    // a different address still gets through
    expect((await app.request("/status", { headers: { "x-forwarded-for": "8.8.8.8" } })).status).toBe(200);
  });

  test("answers are cached for a few seconds, then refreshed", async () => {
    const clock = { t: NOW };
    const { get } = api({ clock });
    expect((await get()).alarmFirings.total).toBe(0);
    await r.recordAlarm("0x09", NOW - 1, TX, "e");
    clock.t += 2;
    expect((await get()).alarmFirings.total).toBe(0);
    clock.t += 10;
    expect((await get()).alarmFirings.total).toBe(1);
  });
});
