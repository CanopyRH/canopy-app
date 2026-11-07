// The public Watchers page: what the indexer records from WatcherSet, what the API logs from /watcher/attest, and the
// GET /watchers route that joins them with the alarms table.
import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { createApi } from "../src/api/server";
import type { AdminEvent } from "../src/indexer/admin";
import { PLUGINS } from "../src/plugins";
import { repo } from "../src/store/repo";
import { signAttest } from "../src/watcher/attest";
import { logAttestation, RECENT_PER_WATCHER, recordWatcherSet, rosterReport, SIGN_SPAN, WINDOW_DAYS } from "../src/watcher/roster";
import { freshDb } from "./db";

const BOOK = "0x00000000000000000000000000000000000000b1" as Address;
const DAY = 86_400;
const NOW = 2_000_000_000;
const W1 = "0xabababababababababababababababababababab";
const W2 = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const W3 = "0xefefefefefefefefefefefefefefefefefefefef";
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** AlarmBook v2's WatcherSet(watcher, since, until). `true` is an approval that is active at NOW, `false` a removal (both zero). */
const setEvent = (watcher: string, term: boolean | { since: number; until: number }, block: number, logIndex = 0): AdminEvent => {
  const t = typeof term === "boolean" ? (term ? { since: NOW - 60 * DAY, until: NOW + 300 * DAY } : { since: 0, until: 0 }) : term;
  return {
    contract: "AlarmBook",
    event: "WatcherSet",
    args: [["watcher", watcher], ["since", String(t.since)], ["until", String(t.until)]],
    tx: hex(block * 10 + logIndex),
    logIndex,
    block: BigInt(block),
  };
};

const attest = (db: Awaited<ReturnType<typeof freshDb>>, signer: string, key: Hex, deadline: number, at: number, evidence = hex(7)) =>
  logAttestation(db, { key, evidence, deadline: BigInt(deadline), signer: signer as Address }, at);

describe("recording WatcherSet", () => {
  test("keeps the event, once, however often the log is replayed", async () => {
    const db = await freshDb();
    expect(await recordWatcherSet(db, setEvent(W1.toUpperCase().replace("0X", "0x"), true, 5), NOW)).toBe(true);
    await recordWatcherSet(db, setEvent(W1, true, 5), NOW + 99);
    const rows = await db.query<{ watcher: string; since: string; until: string; recorded_at: string }>(`SELECT watcher, since::text AS since, until::text AS until, recorded_at FROM watcher_events`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.watcher).toBe(W1); // lower case
    expect(Number(rows[0]!.since)).toBe(NOW - 60 * DAY);
    expect(Number(rows[0]!.until)).toBe(NOW + 300 * DAY);
    expect(Number(rows[0]!.recorded_at)).toBe(NOW); // the first read stands
  });

  test("ignores every other admin event and anything malformed", async () => {
    const db = await freshDb();
    expect(await recordWatcherSet(db, { ...setEvent(W1, true, 1), event: "AdapterSet" }, NOW)).toBe(false);
    expect(await recordWatcherSet(db, { ...setEvent(W1, true, 1), contract: "ExitRouter" }, NOW)).toBe(false);
    expect(await recordWatcherSet(db, setEvent("not an address", true, 1), NOW)).toBe(false);
    expect(await recordWatcherSet(db, { ...setEvent(W1, true, 1), args: [["watcher", W1], ["allowed", "true"]] }, NOW)).toBe(false); // the v1 shape
    expect(await db.query(`SELECT 1 FROM watcher_events`)).toHaveLength(0);
  });
});

describe("the roster", () => {
  test("lists approved watchers by their latest event, and a removal wins over the setting", async () => {
    const db = await freshDb();
    await recordWatcherSet(db, setEvent(W1, true, 5), NOW - 10 * DAY);
    await recordWatcherSet(db, setEvent(W2, true, 6), NOW - 9 * DAY);
    await recordWatcherSet(db, setEvent(W2, false, 20), NOW - 1 * DAY); // removed later
    await recordWatcherSet(db, setEvent(W3, false, 3), NOW - 20 * DAY);
    await recordWatcherSet(db, setEvent(W3, true, 3, 1), NOW - 20 * DAY); // same block, later log: approved
    const r = await rosterReport(db, [W2, W1], NOW); // the setting still lists the removed one
    expect(r.watchers.map((w) => [w.address, w.source])).toEqual([[W1, "chain"], [W3, "chain"]]);
    expect(r.watchers[0]!.approvedAt).toBe(NOW - 10 * DAY);
    expect(r.watchers[0]).toMatchObject({ status: "active", activeFrom: NOW - 60 * DAY, expiresAt: NOW + 300 * DAY });
  });

  test("a new watcher is pending for 2 days, and an approval that has run out is gone", async () => {
    const db = await freshDb();
    await recordWatcherSet(db, setEvent(W1, { since: NOW + 2 * DAY - 60, until: NOW + 365 * DAY }, 5), NOW - 60); // approved a minute ago
    await recordWatcherSet(db, setEvent(W2, { since: NOW - 300 * DAY, until: NOW - 1 }, 6), NOW - 300 * DAY); // ended a second ago
    await recordWatcherSet(db, setEvent(W3, { since: NOW - DAY, until: NOW + 1 }, 7), NOW - 3 * DAY); // ends in a second
    const r = await rosterReport(db, [W2], NOW); // the setting still lists the one that ran out
    expect(r.watchers.map((w) => [w.address, w.status])).toEqual([[W1, "pending"], [W3, "active"]]);
    expect(r.watchers[0]).toMatchObject({ activeFrom: NOW + 2 * DAY - 60, expiresAt: NOW + 365 * DAY });
    const later = await rosterReport(db, [], NOW + 2 * DAY); // two days on, W1 counts and W3 has ended
    expect(later.watchers.map((w) => [w.address, w.status])).toEqual([[W1, "active"]]);
  });

  test("an address with no recorded event counts when this operator lists it", async () => {
    const db = await freshDb();
    const r = await rosterReport(db, [W1.replace("ab", "AB")], NOW);
    expect(r.watchers).toHaveLength(1);
    expect(r.watchers[0]).toMatchObject({ address: W1, source: "config", status: "listed", approvedAt: null, activeFrom: null, expiresAt: null, lastAttestedAt: null, attestations30d: 0, matched30d: 0, recent: [] });
  });

  test("counts the last 30 days, reports the last time, and matches only an alarm inside the signature's span", async () => {
    const db = await freshDb();
    await recordWatcherSet(db, setEvent(W1, true, 1), NOW - 40 * DAY);
    await recordWatcherSet(db, setEvent(W2, true, 2), NOW - 40 * DAY);
    const dl = (at: number) => Math.floor(at / 600) * 600 + 1200; // the deadline watchers sign for an attestation made at `at`
    const alarm = (key: Hex, firedAt: number) => db.query(`INSERT INTO alarms (key, fired_at, tx, evidence) VALUES ($1,$2,'0x','0x')`, [key, firedAt]);

    const t1 = NOW - 2 * DAY; // fired in its span
    await attest(db, W1, hex(1), dl(t1), t1);
    await alarm(hex(1), t1 + 30);
    const t2 = NOW - 3 * DAY; // the same key fired, but long after the signature expired
    await attest(db, W1, hex(2), dl(t2), t2);
    await alarm(hex(2), dl(t2) + 1);
    const t3 = NOW - 4 * DAY; // fired just before the span began
    await attest(db, W1, hex(3), dl(t3), t3);
    await alarm(hex(3), dl(t3) - SIGN_SPAN - 1);
    const t4 = NOW - 5 * DAY; // no alarm at all
    await attest(db, W1, hex(4), dl(t4), t4);
    const t5 = NOW - (WINDOW_DAYS + 0.5) * DAY; // older than the window: shown as the last time only when it is the latest
    await attest(db, W2, hex(5), dl(t5), t5);
    const t6 = NOW - 60; // the newest
    await attest(db, W1, hex(6), dl(t6), t6);
    await alarm(hex(6), dl(t6)); // fired on the deadline itself: still inside

    const r = await rosterReport(db, [], NOW);
    const [w1, w2] = r.watchers;
    expect(w1).toMatchObject({ address: W1, attestations30d: 5, matched30d: 2, lastAttestedAt: t6 });
    expect(w1!.recent.map((x) => [x.key, x.matched])).toEqual([[hex(6), true], [hex(1), true], [hex(2), false], [hex(3), false], [hex(4), false]]);
    expect(w1!.recent[1]!.firedAt).toBe(t1 + 30);
    expect(w1!.recent[3]!.firedAt).toBeNull();
    // W2's only attestation is 30.5 days old: not counted, but it is when it last signed.
    expect(w2).toMatchObject({ address: W2, attestations30d: 0, matched30d: 0, lastAttestedAt: t5, recent: [] });
  });

  test("a repeated attestation counts once, and the log keeps only 31 days", async () => {
    const db = await freshDb();
    await recordWatcherSet(db, setEvent(W1, true, 1), NOW);
    await attest(db, W1.toUpperCase().replace("0X", "0x"), hex(1), NOW + 600, NOW - 100);
    await attest(db, W1, hex(1), NOW + 600, NOW - 5); // gossip delivers it again
    await attest(db, W1, hex(2), NOW + 600, NOW - 32 * DAY); // arrives already too old to keep once the next one prunes
    await attest(db, W1, hex(3), NOW + 600, NOW);
    const r = await rosterReport(db, [], NOW);
    expect(r.watchers[0]).toMatchObject({ attestations30d: 2, lastAttestedAt: NOW });
    expect(await db.query(`SELECT 1 FROM watcher_attest_log`)).toHaveLength(2);
  });

  test("lists at most RECENT_PER_WATCHER attestations, newest first, with the full count above", async () => {
    const db = await freshDb();
    await recordWatcherSet(db, setEvent(W1, true, 1), NOW);
    for (let i = 0; i < RECENT_PER_WATCHER + 10; i++) await attest(db, W1, hex(100 + i), NOW + 600, NOW - 1000 + i);
    const w = (await rosterReport(db, [], NOW)).watchers[0]!;
    expect(w.attestations30d).toBe(RECENT_PER_WATCHER + 10);
    expect(w.recent).toHaveLength(RECENT_PER_WATCHER);
    expect(w.recent[0]!.attestedAt).toBe(NOW - 1000 + RECENT_PER_WATCHER + 9);
  });
});

describe("GET /watchers", () => {
  const api = async (extra: { perMin?: number; watchers?: Address[] } = {}) => {
    const db = await freshDb();
    const app = createApi({
      db, repo: repo(db), vaults: async () => [], liveAlarms: async () => [], watchers: extra.watchers ?? [], alarmBook: BOOK, chainId: 4663,
      now: () => NOW, rateLimit: { perMin: extra.perMin ?? 120, proxyHops: 0 }, plugins: PLUGINS,
    });
    return { db, app };
  };

  test("ships as a shipped plugin and answers with the roster", async () => {
    expect(PLUGINS.map((p) => p.name)).toContain("watchers");
    const { db, app } = await api();
    await recordWatcherSet(db, setEvent(W1, true, 1), NOW - DAY);
    const res = await app.request("/watchers");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["generatedAt", "watchers", "windowDays"]);
    expect(body).toMatchObject({ windowDays: 30, generatedAt: NOW });
    expect(Object.keys(body.watchers[0]).sort()).toEqual(["activeFrom", "address", "approvedAt", "attestations30d", "expiresAt", "lastAttestedAt", "matched30d", "recent", "source", "status"]);
  });

  test("shares the public read limit", async () => {
    const { app } = await api({ perMin: 2 });
    expect((await app.request("/watchers")).status).toBe(200);
    expect((await app.request("/watchers")).status).toBe(200);
    const third = await app.request("/watchers");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
  });

  test("a real signed attestation posted to /watcher/attest shows up, and an unapproved signer does not", async () => {
    const key = generatePrivateKey();
    const acct = privateKeyToAccount(key);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const { db, app } = await api({ watchers: [acct.address] });
    const k = hex(42);
    const evidence = hex(43);
    const deadline = BigInt(Math.floor(NOW / 600) * 600 + 1200);
    const post = async (a: typeof acct) => {
      const sig = await signAttest(a, BOOK, 4663, k, evidence, deadline);
      return app.request("/watcher/attest", { method: "POST", body: JSON.stringify({ key: k, evidence, deadline: deadline.toString(), signer: a.address, sig }) });
    };
    expect((await post(stranger)).status).toBe(403);
    expect((await post(acct)).status).toBe(200);
    expect((await post(acct)).status).toBe(200); // gossip repeats
    await db.query(`INSERT INTO alarms (key, fired_at, tx, evidence) VALUES ($1,$2,'0x','0x')`, [k, NOW + 5]);

    const body = await (await app.request("/watchers")).json();
    expect(body.watchers).toHaveLength(1);
    expect(body.watchers[0]).toMatchObject({ address: acct.address.toLowerCase(), source: "config", attestations30d: 1, matched30d: 1, lastAttestedAt: NOW });
    expect(body.watchers[0].recent[0]).toMatchObject({ key: k, evidence, matched: true, firedAt: NOW + 5 });
    // The unapproved signer left nothing behind.
    expect(await db.query(`SELECT 1 FROM watcher_attest_log WHERE signer=$1`, [stranger.address.toLowerCase()])).toHaveLength(0);
  });
});
