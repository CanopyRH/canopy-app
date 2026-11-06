// Review V3-S02. The keeper decided that an exit job is a "listed vault" job from the position's target alone, never from
// the alarm key. Arming is open to anyone with a plan, and a position on a listed vault can arm keys the attacker
// registered on contracts of their own, fire whenever they like, and replace with fresh ones. So the attacker's jobs:
//   - ran in the "listed" exits loop, which the second review split off so that attacker jobs could not delay listed exits;
//   - were fetched ahead of a victim's job (oldest run_at first, 32 to a page);
//   - never earned strikes: a listed job "keeps its fast retry whatever happened", so a job whose key was replaced (its exit
//     reverts NotAuthorized) or whose position was disarmed was simulated again every 30 s for the alarm's whole day.
// Fixed: a job is a listed job only if its key is one of the vault's presets; a job whose position is gone, disarmed or
// re-armed without its key ends; a retry on any other job earns a strike; and one owner has at most 32 open jobs in the
// queue. The reviewer's 256-job scenario now sends the victim's exit on the first pass. Local mocks and the test database only.
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { presetsFor } from "../../src/api/presets";
import { erc20Abi, multicall3Abi, routerAbi } from "../../src/chain/abi";
import { ALARM_TTL, drainExits, MAX_OPEN_EXITS_PER_OWNER, MAX_STRIKES, onFired, type KeeperDeps } from "../../src/keeper/keeper";
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
const VICTIM_KEY = presetsFor(LISTED)[0]!.key; // the listed vault's own preset
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

describe("V3-S02: attacker keys on a listed vault's position don't get the listed vault's treatment", () => {
  test("control: the same 256 attacker jobs on the attacker's own vault don't touch the listed loop", async () => {
    const { d, st } = keeper(LISTED);
    await attackerJobs(d, OWN_VAULT, 32);
    st.now = FIRED + 60;
    await victimFires(d, st.now);
    expect(await passesUntilVictim(d, st, 50)).toBe(1);
  });

  test("256 jobs from own keys on a position in the listed vault: the victim's exit goes out on the first pass, after a handful of node requests", async () => {
    const { d, st } = keeper(LISTED);
    await attackerJobs(d, LISTED, 32); // 32 re-arms, 256 fires: one plan, a few hundred cheap transactions
    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind='exit' AND NOT done`))[0]!.n)).toBe(256);
    st.now = FIRED + 60;
    await victimFires(d, st.now);
    const passes = await passesUntilVictim(d, st, 50);
    expect(passes).toBe(1);
    // Before: 8 passes of attacker work first, over 2,000 node requests. The listed loop never sees the attacker's keys.
    expect(st.victimSentAtRpc).toBeLessThan(40);
  });

  test("the same, with every loop running: the victim is still the first transaction of the first pass", async () => {
    const { d, st } = keeper(LISTED);
    await attackerJobs(d, LISTED, 32);
    st.now = FIRED + 60;
    await victimFires(d, st.now);
    await drainExits(d); // scope "all": listed jobs are fetched first
    expect(st.victimLeft).toBe(0n);
    expect(st.victimSentAtRpc).toBeLessThan(40);
  });

  test("jobs whose key was replaced end on the first pass instead of retrying all day, and the live ones earn a strike", async () => {
    const { d } = keeper(LISTED);
    await attackerJobs(d, LISTED, 2); // the first 8 jobs' keys were replaced by the second arm
    const stale = (await db.query<{ id: string }>(`SELECT id FROM jobs WHERE payload->>'key'=$1`, [ownKey(0)]))[0]!.id;
    await drainExits(d, "unlisted");
    expect(await db.query(`SELECT 1 FROM jobs WHERE id=$1`, [stale])).toEqual([]); // ended
    // The 8 live keys' jobs were tried (their exit reverts) and each earned a strike.
    const live = await db.query<{ strikes: number; done: boolean }>(`SELECT strikes, done FROM jobs WHERE payload->>'key' = ANY($1::text[])`, [`{${Array.from({ length: 8 }, (_, i) => ownKey(8 + i)).join(",")}}`]);
    expect(live).toHaveLength(8);
    expect(live.every((j) => j.strikes === 1 && !j.done)).toBe(true);
  });

  test("a job on a key that is armed but whose exit keeps failing earns strikes and ends after MAX_STRIKES", async () => {
    const { d, st } = keeper(LISTED);
    await attackerJobs(d, LISTED, 1);
    const job = (await db.query<{ id: string }>(`SELECT id FROM jobs WHERE payload->>'key'=$1`, [ownKey(0)]))[0]!.id;
    // A pass every two hours of the alarm's day.
    for (st.now = FIRED; st.now <= FIRED + ALARM_TTL - 60; st.now += 7_200) await drainExits(d, "unlisted");
    const row = (await db.query<{ done: boolean; strikes: number }>(`SELECT done, strikes FROM jobs WHERE id=$1`, [job]))[0]!;
    expect(row).toEqual({ done: true, strikes: MAX_STRIKES });
  });

  test("a disarmed position's jobs end", async () => {
    const { d } = keeper(LISTED);
    await attackerJobs(d, LISTED, 1);
    await r.disarm(ATTACKER_POS);
    await drainExits(d, "unlisted");
    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind='exit' AND NOT done`))[0]!.n)).toBe(0);
  });

  test("one owner has at most MAX_OPEN_EXITS_PER_OWNER open jobs in the queue, however many positions and keys", async () => {
    const { d } = keeper(OWN_VAULT);
    for (let p = 0; p < 6; p++) {
      const posId = `0x${"e"}${p.toString(16).padStart(63, "0")}` as Hex;
      const keys = Array.from({ length: 8 }, (_, i) => ownKey(p * 8 + i));
      await r.upsertPosition({ posId, owner: ATTACKER.toLowerCase(), adapter: ROUTER, target: OWN_VAULT.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys });
      for (const k of keys) await onFired(d, k, FIRED);
    }
    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind='exit' AND NOT done`))[0]!.n)).toBe(48);
    expect((await r.dueJobs("exit", FIRED, 100, undefined, MAX_OPEN_EXITS_PER_OWNER)).length).toBe(MAX_OPEN_EXITS_PER_OWNER);
    // Another owner's job is not held back by the first owner's.
    await victimFires(d, FIRED);
    expect((await r.dueJobs("exit", FIRED, 100, undefined, MAX_OPEN_EXITS_PER_OWNER)).length).toBe(MAX_OPEN_EXITS_PER_OWNER + 1);
  });
});
