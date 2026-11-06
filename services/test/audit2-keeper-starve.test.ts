// Audit 2 PoCs: exit-queue head-of-line blocking in drainExits.
//
// A2-H1: a bundle job whose simulated exit costs more than BUNDLE_GAS is neither sent, refused nor rescheduled, so it
//        keeps its old run_at and is fetched first on every pass. 32 of them fill dueJobs' LIMIT 32 for good, and no
//        later exit (listed vault or not) is ever fetched again while they stay within their 24 h TTL.
// A2-M1: the per-job time budget bounds one job, not a pass. A pass runs up to 32 jobs one after another, and "listed
//        first" only sorts inside the 32 fetched rows, so N slow attacker jobs queued ahead delay every honest exit by
//        about ceil(N/32) * 32 * JOB_BUDGET_MS.
//
// Everything is local mocks and the in-process database. Run: bun test test/audit2-keeper-starve.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { erc20Abi, routerAbi } from "../src/chain/abi";
import { BUNDLE_GAS, drainExits, JOB_BUDGET_MS, onFired, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const ROUTER = "0x00000000000000000000000000000000000000b0" as Address;
const BOOK = "0x00000000000000000000000000000000000000b1" as Address;
const MC3 = "0x00000000000000000000000000000000000000b2" as Address;
const KEEPER = "0x00000000000000000000000000000000000000b3" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address;
const LISTED = "0x00000000000000000000000000000000000000a1" as Address;
const ATTACKER = "0xabababababababababababababababababababab" as Address;
const VICTIM = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" as Address;
const hostile = (i: number) => `0x00000000000000000000000000000000000e${i.toString(16).padStart(4, "0")}` as Address;
const b32 = (tag: string, i: number) => `0x${tag}${i.toString(16).padStart(64 - tag.length, "0")}` as Hex;
const FIRED = 1_000;
const TX = `0x${"11".repeat(32)}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  // Both wallets hold a 15-unit plan, so onFired queues their jobs like anyone else's.
  await r.setPaidUntil(ATTACKER, 10_000_000);
  await r.setPaidUntil(VICTIM, 10_000_000);
});

/** Arms one position per target with the given keys, fires every key once, and returns the posIds. */
async function armAndFire(d: KeeperDeps, owner: Address, targets: Address[], keys: Hex[], firedAt: number) {
  const ids: Hex[] = [];
  for (const [i, target] of targets.entries()) {
    const posId = b32(owner === VICTIM ? "f" : "e", i);
    ids.push(posId);
    await r.upsertPosition({ posId, owner: owner.toLowerCase(), adapter: ROUTER, target: target.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys });
  }
  for (const k of keys) await onFired(d, k, firedAt);
  return ids;
}

const bal = (v: bigint) => encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: v });

/**
 * Stand-in for eth_simulateV1. Each exit is surrounded by three balance reads (owner, router, keeper) before and after,
 * as gateExit and runBundle lay them out. After an exit the owner's read goes up by 1, so the balance gate passes.
 * `exitGas` decides what the node reports as the exit's gasUsed.
 */
function simulator(exitGas: (posId: Hex) => bigint, log: { posId: Hex }[] = []) {
  return async ({ calls }: { calls: { to: Address; data: Hex }[] }) => {
    const results = calls.map((c, i) => {
      if (c.to.toLowerCase() === ROUTER.toLowerCase()) {
        const { args } = decodeFunctionData({ abi: routerAbi, data: c.data });
        const posId = (args as unknown as [Hex])[0];
        log.push({ posId });
        return { status: "success", data: "0x" as Hex, gasUsed: exitGas(posId) };
      }
      // A read: it is "after" if an exit sits 1..3 places before it with only reads between.
      let k = 1;
      while (k <= 3 && i - k >= 0 && calls[i - k]!.to.toLowerCase() !== ROUTER.toLowerCase()) k++;
      const after = k <= 3 && i - k >= 0;
      return { status: "success", data: bal(after && k === 1 ? 1n : 0n), gasUsed: 30_000n };
    });
    return { results };
  };
}

describe("A2-H1: bundle jobs over BUNDLE_GAS are never rescheduled and starve every later exit", () => {
  const KEYS = Array.from({ length: 8 }, (_, i) => b32("a", i)); // a position may arm up to 8 keys
  const VKEY = b32("c", 1);

  async function scenario(hostileJobs: number) {
    const sent: { to: Address; data: Hex }[] = [];
    let now = FIRED;
    let victimLeft = 100n;
    const d = {
      repo: r, router: ROUTER, alarmBook: BOOK, multicall3: MC3, morpho: BOOK, account: KEEPER, paidOnly: true,
      listed: new Set([LISTED.toLowerCase()]), now: () => now,
      client: {
        // exitable(): balance and allowance of every job's owner on its target. The attacker's contracts report shares.
        multicall: async ({ contracts }: { contracts: { address: Address; args: Address[] }[] }) =>
          contracts.map((c) => (c.address.toLowerCase() === LISTED.toLowerCase() ? victimLeft : 100n)),
        readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          if (functionName === "asset") return TOKEN;
          if (functionName === "balanceOf" || functionName === "allowance") return address.toLowerCase() === LISTED.toLowerCase() ? victimLeft : 100n;
          throw new Error(`${functionName} is not a Vault V2 read here`); // no deallocation path
        },
        // The attacker's vault burns 11M gas inside redeem; an honest exit costs 300k.
        simulateCalls: simulator((posId) => (posId.startsWith("0xe") ? 11_000_000n : 300_000n)),
      },
      send: async (tx: { to: Address; data: Hex }) => {
        sent.push(tx);
        if (tx.to.toLowerCase() === ROUTER.toLowerCase()) victimLeft = 0n;
        return TX;
      },
    } as unknown as KeeperDeps;

    // The attacker's alarms fired first: 4 of their own vaults, one position each, armed with 8 keys that all fired.
    const vaults = Math.ceil(hostileJobs / 8);
    const targets = Array.from({ length: vaults }, (_, i) => hostile(i));
    await armAndFire(d, ATTACKER, targets, KEYS, FIRED);
    // Trim to the exact count wanted.
    const extra = vaults * 8 - hostileJobs;
    if (extra > 0) await db.query(`DELETE FROM jobs WHERE id IN (SELECT id FROM jobs ORDER BY id DESC LIMIT $1)`, [extra]);
    const before = await db.query<{ id: string; run_at: string; attempts: number }>(`SELECT id, run_at, attempts FROM jobs ORDER BY id`);

    // A minute later a real alarm fires on a listed vault, for a paying user.
    now = FIRED + 60;
    await armAndFire(d, VICTIM, [LISTED], [VKEY], now);

    // Ten keeper passes, ten minutes apart.
    for (let pass = 0; pass < 10; pass++) {
      await drainExits(d);
      now += 600;
    }
    const after = await db.query<{ id: string; run_at: string; attempts: number }>(`SELECT id, run_at, attempts FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id`, [before.map((x) => x.id)]);
    const victimJob = (await db.query<{ done: boolean; attempts: number }>(`SELECT done, attempts FROM jobs WHERE payload->>'owner'=$1`, [VICTIM.toLowerCase()]))[0]!;
    return { sent, before, after, victimJob };
  }

  test("32 over-budget attacker jobs: the listed vault's exit is never fetched, and the attacker's jobs never move", async () => {
    const { sent, before, after, victimJob } = await scenario(32);
    expect(before).toHaveLength(32);
    // Nothing was sent in 100 minutes of passes, so the victim's exit never happened.
    expect(sent).toHaveLength(0);
    expect(victimJob).toEqual({ done: false, attempts: 0 });
    // The attacker's jobs keep their original run_at and attempts: drainExits neither finished nor rescheduled them.
    expect(after).toEqual(before);
    console.log(`A2-H1: 32 attacker jobs over the ${BUNDLE_GAS} gas bundle budget; 10 passes, ${sent.length} transactions; victim job attempts=${victimJob.attempts}`);
  });

  test("control: with 31 such jobs the victim's exit is fetched and sent on the first pass", async () => {
    const { sent, victimJob } = await scenario(31);
    expect(sent.length).toBe(1);
    expect(victimJob.done).toBe(true);
  });
});

describe("A2-M1: slow attacker jobs delay every honest exit by passes of 32 x the job budget", () => {
  test("64 hanging attacker jobs queued first hold a listed vault's exit back for two full passes", async () => {
    const BUDGET = 20; // ms here; JOB_BUDGET_MS in production
    const never = () => new Promise<never>(() => {});
    let now = FIRED;
    let victimLeft = 100n;
    const sent: Address[] = [];
    const d = {
      repo: r, router: ROUTER, alarmBook: BOOK, multicall3: MC3, morpho: BOOK, account: KEEPER, paidOnly: true,
      listed: new Set([LISTED.toLowerCase()]), now: () => now, jobBudgetMs: BUDGET,
      client: {
        readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          if (address.toLowerCase() !== LISTED.toLowerCase()) return never(); // reads the attacker's contracts answer slowly
          if (functionName === "asset") return TOKEN;
          if (functionName === "balanceOf" || functionName === "allowance") return victimLeft;
          throw new Error("not v2");
        },
        simulateCalls: simulator(() => 300_000n),
      },
      send: async (tx: { to: Address }) => {
        sent.push(tx.to);
        victimLeft = 0n;
        return TX;
      },
    } as unknown as KeeperDeps;

    // 64 attacker positions on 64 different contracts (so no bundling), one key, fired once.
    const AKEY = b32("a", 9);
    await armAndFire(d, ATTACKER, Array.from({ length: 64 }, (_, i) => hostile(i)), [AKEY], FIRED);
    now = FIRED + 1;
    await armAndFire(d, VICTIM, [LISTED], [b32("c", 2)], now);

    const passes: number[] = [];
    while (sent.length === 0 && passes.length < 5) {
      const t0 = performance.now();
      await drainExits(d);
      passes.push(performance.now() - t0);
      now += 1;
    }
    console.log(`A2-M1: victim exit sent after ${passes.length} passes; pass times ${passes.map((p) => p.toFixed(0)).join(", ")} ms at a ${BUDGET} ms budget`);
    expect(passes.length).toBe(3);
    // The first two passes each spent about 32 budgets on attacker jobs. In production that is 2 x 32 x 45 s = 48 minutes.
    expect(passes[0]!).toBeGreaterThanOrEqual(32 * BUDGET * 0.9);
    expect(passes[1]!).toBeGreaterThanOrEqual(32 * BUDGET * 0.9);
    expect((2 * 32 * JOB_BUDGET_MS) / 60_000).toBe(48);
  }, 20_000);
});
