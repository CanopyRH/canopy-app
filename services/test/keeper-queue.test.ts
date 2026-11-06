// The exit queue under attack. Arming is open to anyone with a plan, so these tests queue an attacker's jobs on
// contracts built to hold the queue up, then check that a real alarm on a listed vault still exits on the first pass.
//
// - A job whose simulated exit costs more than BUNDLE_GAS used to be neither sent, refused nor rescheduled. It kept its
//   run_at, so 32 of them filled dueJobs' page of 32 for good. Now listed vaults' jobs are fetched first, and every
//   fetched job is sent, refused or rescheduled.
// - The per-job time budget bounded one job, not a pass, so N slow jobs ahead of an honest one delayed it by about
//   N x JOB_BUDGET_MS. Now the pass has a budget too, and listed vaults can run in a loop of their own.
// - A job past its budget kept running in the background and could still send. Now it checks a signal before sending.
//
// Local mocks and the in-process database only.
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { presetsFor } from "../src/api/presets";
import { erc20Abi, routerAbi } from "../src/chain/abi";
import { drainExits, onFired, SLOW_RETRY_SEC, type KeeperDeps } from "../src/keeper/keeper";
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
  // Both wallets hold a plan, so onFired queues their jobs like anyone else's.
  await r.setPaidUntil(ATTACKER, 10_000_000);
  await r.setPaidUntil(VICTIM, 10_000_000);
});

/** Arms one position per target with the given keys, and fires every key once. */
async function armAndFire(d: KeeperDeps, owner: Address, targets: Address[], keys: Hex[], firedAt: number) {
  for (const [i, target] of targets.entries()) {
    const posId = b32(owner === VICTIM ? "f" : "e", i);
    await r.upsertPosition({ posId, owner: owner.toLowerCase(), adapter: ROUTER, target: target.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys });
  }
  for (const k of keys) await onFired(d, k, firedAt);
}

const bal = (v: bigint) => encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: v });
const exitOf = (data: Hex) => (decodeFunctionData({ abi: routerAbi, data }).args as unknown as [Hex])[0];

/**
 * Stand-in for eth_simulateV1. Each exit is surrounded by three balance reads (owner, router, keeper) before and after,
 * as gateExit and runBundle lay them out. After an exit the owner's read goes up by 1, so the balance gate passes.
 */
function simulator(exitGas: (posId: Hex) => bigint) {
  return async ({ calls }: { calls: { to: Address; data: Hex }[] }) => {
    const results = calls.map((c, i) => {
      if (c.to.toLowerCase() === ROUTER.toLowerCase()) return { status: "success", data: "0x" as Hex, gasUsed: exitGas(exitOf(c.data)) };
      let k = 1;
      while (k <= 3 && i - k >= 0 && calls[i - k]!.to.toLowerCase() !== ROUTER.toLowerCase()) k++;
      const after = k <= 3 && i - k >= 0;
      return { status: "success", data: bal(after && k === 1 ? 1n : 0n), gasUsed: 30_000n };
    });
    return { results };
  };
}

describe("exit jobs too big for a bundle can't freeze the queue", () => {
  const KEYS = Array.from({ length: 8 }, (_, i) => b32("a", i)); // a position may arm up to 8 keys
  const VKEY = presetsFor(LISTED)[0]!.key; // the listed vault's own preset

  async function scenario(hostileJobs: number, passes: number) {
    const sent: { to: Address; data: Hex }[] = [];
    let now = FIRED;
    let victimLeft = 100n;
    const d = {
      repo: r, router: ROUTER, alarmBook: BOOK, multicall3: MC3, morpho: BOOK, account: KEEPER, paidOnly: true,
      listed: new Set([LISTED.toLowerCase()]), now: () => now,
      client: {
        multicall: async ({ contracts }: { contracts: { address: Address }[] }) =>
          contracts.map((c) => (c.address.toLowerCase() === LISTED.toLowerCase() ? victimLeft : 100n)),
        readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          if (functionName === "asset") return TOKEN;
          if (functionName === "balanceOf" || functionName === "allowance") return address.toLowerCase() === LISTED.toLowerCase() ? victimLeft : 100n;
          throw new Error(`${functionName} is not a Vault V2 read here`);
        },
        // The attacker's vault burns 11M gas inside redeem; an honest exit costs 300k.
        simulateCalls: simulator((posId) => (posId.startsWith("0xe") ? 11_000_000n : 300_000n)),
      },
      send: async (tx: { to: Address; data: Hex }) => {
        sent.push(tx);
        if (tx.to.toLowerCase() === ROUTER.toLowerCase() && exitOf(tx.data).startsWith("0xf")) victimLeft = 0n;
        return TX;
      },
    } as unknown as KeeperDeps;

    // The attacker's alarms fired first: their own vaults, one position each, armed with 8 keys that all fired.
    const vaults = Math.ceil(hostileJobs / 8);
    await armAndFire(d, ATTACKER, Array.from({ length: vaults }, (_, i) => hostile(i)), KEYS, FIRED);
    const extra = vaults * 8 - hostileJobs;
    if (extra > 0) await db.query(`DELETE FROM jobs WHERE id IN (SELECT id FROM jobs ORDER BY id DESC LIMIT $1)`, [extra]);
    const before = await db.query<{ id: string; run_at: string; attempts: number }>(`SELECT id, run_at, attempts FROM jobs ORDER BY id`);

    // A minute later a real alarm fires on a listed vault, for a paying user.
    now = FIRED + 60;
    await armAndFire(d, VICTIM, [LISTED], [VKEY], now);

    const sentAfterPass: number[] = [];
    for (let pass = 0; pass < passes; pass++) {
      await drainExits(d);
      sentAfterPass.push(sent.length);
      now += 600;
    }
    const after = await db.query<{ id: string; run_at: string; attempts: number; done: boolean }>(`SELECT id, run_at, attempts, done FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id`, [before.map((x) => x.id)]);
    const victimJob = (await db.query<{ done: boolean; attempts: number }>(`SELECT done, attempts FROM jobs WHERE payload->>'owner'=$1`, [VICTIM.toLowerCase()]))[0]!;
    return { sent, before, after, victimJob };
  }

  test("32 attacker jobs over the bundle budget: the listed vault's exit is the first transaction of the first pass", async () => {
    const { sent, before, after, victimJob } = await scenario(32, 1);
    expect(before).toHaveLength(32);
    expect(victimJob).toEqual({ done: true, attempts: 0 });
    expect(exitOf(sent[0]!.data).startsWith("0xf")).toBe(true);
    // Every attacker job the pass fetched was sent, refused or rescheduled: none kept its place at the head of the queue.
    const fetched = after.filter((a) => !a.done);
    const untouched = fetched.filter((a) => {
      const b = before.find((x) => x.id === a.id)!;
      return Number(a.run_at) === Number(b.run_at) && a.attempts === b.attempts;
    });
    // The page holds 32 jobs and the victim's took one place, so one attacker job wasn't fetched this pass.
    expect(untouched.length).toBeLessThanOrEqual(1);
  });

  test("64 such jobs: still the first pass, because the page is filled with listed vaults' jobs first", async () => {
    const { sent, victimJob } = await scenario(64, 1);
    expect(victimJob.done).toBe(true);
    expect(exitOf(sent[0]!.data).startsWith("0xf")).toBe(true);
  });

  test("over ten passes, the attacker's jobs keep moving and never stall the queue", async () => {
    const { after, victimJob } = await scenario(32, 10);
    expect(victimJob.done).toBe(true);
    // Each was handled at least once; none sits at its original run_at with no attempt recorded.
    expect(after.every((a) => a.done || a.attempts > 0)).toBe(true);
  });
});

describe("slow attacker jobs can't hold back an honest exit by whole passes", () => {
  const BUDGET = 50; // ms here; JOB_BUDGET_MS in production
  const never = () => new Promise<never>(() => {});

  async function setup() {
    let now = FIRED;
    let victimLeft = 100n;
    const sent: Address[] = [];
    const d = {
      repo: r, router: ROUTER, alarmBook: BOOK, multicall3: MC3, morpho: BOOK, account: KEEPER, paidOnly: true,
      listed: new Set([LISTED.toLowerCase()]), now: () => now, jobBudgetMs: BUDGET, passBudgetMs: 3 * BUDGET,
      client: {
        readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          if (address.toLowerCase() !== LISTED.toLowerCase()) return never(); // the attacker's contracts never answer
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
    // 64 attacker positions on 64 different contracts (so no bundling), one key, fired first.
    await armAndFire(d, ATTACKER, Array.from({ length: 64 }, (_, i) => hostile(i)), [b32("a", 9)], FIRED);
    now = FIRED + 1;
    await armAndFire(d, VICTIM, [LISTED], [presetsFor(LISTED)[0]!.key], now);
    return { d, sent };
  }

  test("64 hanging jobs queued first: the listed vault's exit goes on the first pass, and the pass stops at its budget", async () => {
    const { d, sent } = await setup();
    const t0 = performance.now();
    await drainExits(d);
    const ms = performance.now() - t0;
    expect(sent).toEqual([ROUTER]);
    // Before, this pass waited out 32 job budgets (1,600 ms here, 24 minutes in production).
    expect(ms).toBeLessThan(16 * BUDGET);
    // The jobs it didn't reach stay due, untouched.
    expect((await r.dueJobs("exit", FIRED + 1)).length).toBeGreaterThan(0);
  });

  test("the listed loop never waits on another vault's job", async () => {
    const { d, sent } = await setup();
    const t0 = performance.now();
    await drainExits(d, "listed");
    expect(performance.now() - t0).toBeLessThan(BUDGET);
    expect(sent).toEqual([ROUTER]);
    // And the other loop leaves the listed vault's jobs alone.
    const rows = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM jobs WHERE NOT done AND attempts=0`);
    await drainExits(d, "unlisted");
    expect(sent).toEqual([ROUTER]);
    expect(Number((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM jobs WHERE NOT done AND attempts=0`))[0]!.n)).toBeLessThan(Number(rows[0]!.n));
  });
});

describe("a job past its budget", () => {
  test("is cancelled before it can send, even when its reads answer later", async () => {
    const BUDGET = 30;
    const sent: unknown[] = [];
    const d = {
      repo: r, router: ROUTER, alarmBook: BOOK, multicall3: MC3, morpho: BOOK, account: KEEPER, paidOnly: true,
      listed: new Set([LISTED.toLowerCase()]), now: () => FIRED, jobBudgetMs: BUDGET,
      client: {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "asset") {
            await Bun.sleep(3 * BUDGET); // answers, but only after the budget is spent
            return TOKEN;
          }
          if (functionName === "balanceOf" || functionName === "allowance") return 100n;
          throw new Error("not v2");
        },
        simulateCalls: simulator(() => 300_000n),
      },
      send: async (tx: unknown) => {
        sent.push(tx);
        return TX;
      },
    } as unknown as KeeperDeps;
    await armAndFire(d, VICTIM, [LISTED], [presetsFor(LISTED)[0]!.key], FIRED);
    await drainExits(d);
    await Bun.sleep(6 * BUDGET); // let the abandoned job run to where it would send
    expect(sent).toEqual([]);
    const [job] = await db.query<{ run_at: string; done: boolean }>(`SELECT run_at, done FROM jobs`);
    expect([Number(job!.run_at), job!.done]).toEqual([FIRED + SLOW_RETRY_SEC, false]);
  });
});
