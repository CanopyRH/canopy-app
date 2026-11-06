// Review V3-S02. The keeper decides that an exit job is a "listed vault" job from the position's target alone, never from
// the alarm key. Arming is open to anyone with a plan, and a position on a listed vault can arm keys the attacker
// registered on contracts of their own, fire whenever they like, and replace with fresh ones. So the attacker's jobs:
//   - run in the "listed" exits loop, which the second review split off so that attacker jobs could not delay listed exits;
//   - are fetched ahead of a victim's job (oldest run_at first, 32 to a page);
//   - never earn strikes: a listed job "keeps its fast retry whatever happened", so a job whose key was replaced (its exit
//     reverts NotAuthorized) or whose position was disarmed is simulated again every 30 s for the alarm's whole day.
// A victim's exit on that listed vault waits behind every attacker job due before it, so the delay grows with the
// number of jobs the attacker creates (8 per fire, one re-arm per 8 keys). Local mocks and the test database only.
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { erc20Abi, multicall3Abi, routerAbi } from "../../src/chain/abi";
import { ALARM_TTL, drainExits, onFired, RETRY_SEC, type KeeperDeps } from "../../src/keeper/keeper";
import type { Db } from "../../src/store/db";
import { repo, type Repo } from "../../src/store/repo";
import { freshDb } from "../db";

const ROUTER = "0x00000000000000000000000000000000000000b0" as Address;
const BOOK = "0x00000000000000000000000000000000000000b1" as Address;
const MC3 = "0x00000000000000000000000000000000000000b2" as Address;
const KEEPER = "0x00000000000000000000000000000000000000b3" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address;
const LISTED = "0x00000000000000000000000000000000000000a1" as Address;
const OWN_VAULT = "0x00000000000000000000000000000000000000e1" as Address;
const ATTACKER = "0xabababababababababababababababababababab" as Address;
const VICTIM = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" as Address;
const ATTACKER_POS = `0x${"e0".repeat(32)}` as Hex;
const VICTIM_POS = `0x${"f0".repeat(32)}` as Hex;
const VICTIM_KEY = `0x${"c1".repeat(32)}` as Hex; // the listed vault's own preset
/** Keys the attacker registered on a contract of their own (a PAUSED detector they can switch on). */
const ownKey = (i: number) => `0x${"a"}${i.toString(16).padStart(63, "0")}` as Hex;
const FIRED = 1_000;
const TX = `0x${"11".repeat(32)}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  await r.setPaidUntil(ATTACKER.toLowerCase(), 10_000_000); // one plan
  await r.setPaidUntil(VICTIM.toLowerCase(), 10_000_000);
});

const bal = (v: bigint) => encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: v });

function keeper(target: Address) {
  const st = { rpc: 0, victimSentAtRpc: -1, victimLeft: 100n, now: FIRED };
  const owner = (a: unknown) => String(a).toLowerCase();
  const d = {
    repo: r, router: ROUTER, alarmBook: BOOK, multicall3: MC3, morpho: BOOK, account: KEEPER, paidOnly: true,
    listed: new Set([LISTED.toLowerCase()]), now: () => st.now,
    client: {
      multicall: async ({ contracts }: { contracts: { args: unknown[] }[] }) => {
        st.rpc++;
        return contracts.map((c) => (owner(c.args[0]) === VICTIM.toLowerCase() ? st.victimLeft : 100n));
      },
      readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        st.rpc++;
        if (functionName === "asset") return TOKEN;
        if (functionName === "balanceOf" || functionName === "allowance") return owner(args![0]) === VICTIM.toLowerCase() ? st.victimLeft : 100n;
        throw new Error(`${functionName}: not a Vault V2`); // no deallocation path
      },
      // The attacker's exits revert (a replaced key: NotAuthorized). The victim's passes the gate.
      simulateCalls: async ({ calls }: { calls: { to: Address; data: Hex }[] }) => {
        st.rpc++;
        const results = calls.map((c, i) => {
          if (c.to.toLowerCase() === ROUTER.toLowerCase()) {
            const [posId] = decodeFunctionData({ abi: routerAbi, data: c.data }).args as unknown as [Hex];
            return posId === ATTACKER_POS ? { status: "failure", data: "0x" as Hex, gasUsed: 60_000n } : { status: "success", data: "0x" as Hex, gasUsed: 300_000n };
          }
          let k = 1;
          while (k <= 3 && i - k >= 0 && calls[i - k]!.to.toLowerCase() !== ROUTER.toLowerCase()) k++;
          const after = k <= 3 && i - k >= 0;
          return { status: "success", data: bal(after && k === 1 ? 1n : 0n), gasUsed: 30_000n };
        });
        return { results };
      },
    },
    send: async (tx: { to: Address; data: Hex }) => {
      const victimIn = (data: Hex) => data.toLowerCase().includes(VICTIM_POS.slice(2));
      if (tx.to.toLowerCase() === MC3.toLowerCase()) {
        const [calls] = decodeFunctionData({ abi: multicall3Abi, data: tx.data }).args as unknown as [{ callData: Hex }[]];
        if (calls.some((c) => victimIn(c.callData))) st.victimLeft = 0n;
      } else if (victimIn(tx.data)) st.victimLeft = 0n;
      if (st.victimLeft === 0n && st.victimSentAtRpc < 0) st.victimSentAtRpc = st.rpc;
      return TX;
    },
  } as unknown as KeeperDeps;
  return { d, st };
}

/** The attacker's position on `target`: arm 8 own keys, fire them, re-arm with 8 fresh keys, and so on. */
async function attackerJobs(d: KeeperDeps, target: Address, rounds: number) {
  for (let round = 0; round < rounds; round++) {
    const keys = Array.from({ length: 8 }, (_, i) => ownKey(round * 8 + i));
    await r.upsertPosition({ posId: ATTACKER_POS, owner: ATTACKER.toLowerCase(), adapter: ROUTER, target: target.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: BigInt(10 + round), termsHash: "t", keys });
    for (const k of keys) await onFired(d, k, FIRED + round);
  }
}

async function victimFires(d: KeeperDeps, at: number) {
  await r.upsertPosition({ posId: VICTIM_POS, owner: VICTIM.toLowerCase(), adapter: ROUTER, target: LISTED.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [VICTIM_KEY] });
  expect(await onFired(d, VICTIM_KEY, at)).toBe(1);
}

/** Passes of the listed exits loop, a second apart, until the victim's exit is sent. */
async function passesUntilVictim(d: KeeperDeps, st: { now: number; victimLeft: bigint }, max: number) {
  for (let pass = 1; pass <= max; pass++) {
    await drainExits(d, "listed");
    if (st.victimLeft === 0n) return pass;
    st.now += 1;
  }
  return Infinity;
}

describe("V3-S02: attacker keys on a listed vault's position get the listed vault's treatment", () => {
  test("control: the same 256 attacker jobs on the attacker's own vault don't touch the listed loop", async () => {
    const { d, st } = keeper(LISTED);
    await attackerJobs(d, OWN_VAULT, 32);
    st.now = FIRED + 60;
    await victimFires(d, st.now);
    expect(await passesUntilVictim(d, st, 50)).toBe(1);
  });

  test("256 jobs from own keys on a position in the listed vault: the victim's exit waits 9 passes and ~1,800 node requests", async () => {
    const { d, st } = keeper(LISTED);
    await attackerJobs(d, LISTED, 32); // 32 re-arms, 256 fires: one plan, a few hundred cheap transactions
    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind='exit' AND NOT done`))[0]!.n)).toBe(256);
    st.now = FIRED + 60;
    await victimFires(d, st.now);
    const passes = await passesUntilVictim(d, st, 50);
    // 256 attacker jobs at 32 a page, every one fetched ahead of the victim's: 8 passes of attacker work first.
    expect(passes).toBe(9);
    // Each attacker job costs a bundle simulation share, then runExit: 3 reads and 6 sized simulations, all failing.
    expect(st.victimSentAtRpc).toBeGreaterThan(256 * 8);
    console.log(`victim's exit sent on pass ${passes}, after ${st.victimSentAtRpc} node requests`);
  });

  test("a job whose key was replaced never earns a strike: retried every 30 s until the alarm's day is over", async () => {
    const { d, st } = keeper(LISTED);
    await attackerJobs(d, LISTED, 2); // the first 8 jobs' keys were replaced by the second arm
    const stale = (await db.query<{ id: string }>(`SELECT id FROM jobs WHERE payload->>'key'=$1`, [ownKey(0)]))[0]!.id;
    // A pass every two hours of the alarm's day (the real loop runs every second, and the job is due every 30 s).
    let passes = 0;
    for (st.now = FIRED; st.now <= FIRED + ALARM_TTL - RETRY_SEC; st.now += 7_200) {
      await drainExits(d, "listed");
      passes++;
    }
    const job = (await db.query<{ done: boolean; strikes: number; attempts: number }>(`SELECT done, strikes, attempts FROM jobs WHERE id=$1`, [stale]))[0]!;
    expect(job.done).toBe(false);
    expect(job.strikes).toBe(0);
    expect(job.attempts).toBe(passes); // every pass retried it; at the real pace that is ~2,880 attempts, each 6+ simulations
  });
});
