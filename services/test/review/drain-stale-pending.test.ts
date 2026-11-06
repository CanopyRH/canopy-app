// Review V3-S04. After a poke that didn't fire, pokeTripped reads state(key).pendingAt and, if it is non-zero, counts the
// poke as progress: it clears the key's miss count and sets it aside for only DRAIN_CONFIRM + 2 s. It never asks whether
// this poke set that sighting. A DRAIN sighting lasts `window` seconds, and window is the registrant's choice (any
// uint32 >= 1200, so up to 136 years). An attacker's DRAIN key with one old sighting therefore turns the A2-M3 defence
// off: a key that looks like it fires in the check and the simulation but doesn't in the real transaction is sent every
// ~62 s forever, instead of backing off to once an hour like any other key. Each send carries READ_GAS_FLOOR (1.6M) and
// the target can spend its full 1M read on every one.
//
// The discriminator between the simulation and the transaction is the attacker's problem; the A2-M3 tests assume one
// exists (gas price in eth_call). Here the stand-in node simply says "fires" when simulated and "doesn't" when sent.
// Local mocks and the test database.
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { alarmBookAbi } from "../../src/chain/abi";
import { Kind } from "../../src/api/presets";
import { pokeTripped, READ_GAS_FLOOR, type KeeperDeps } from "../../src/keeper/keeper";
import type { Db } from "../../src/store/db";
import { repo, type Repo } from "../../src/store/repo";
import { checkNode } from "../check-node";
import { freshDb } from "../db";

const BOOK = "0x00000000000000000000000000000000000000b0" as Address;
const KEEPER = "0x00000000000000000000000000000000000000b3" as Address;
const OWN = "0x00000000000000000000000000000000000e0002" as Address;
const OWNER = "0xabababababababababababababababababababab";
const TX = `0x${"11".repeat(32)}` as Hex;
const DRAIN = `0x${"d1".repeat(32)}` as Hex;
const SHARE = `0x${"5d".repeat(32)}` as Hex;
const ZERO = `0x${"00".repeat(32)}`;
const pokeResult = (fired: boolean) => encodeFunctionResult({ abi: alarmBookAbi, functionName: "poke", result: fired });

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  await r.setPaidUntil(OWNER, 10_000_000);
});

/** One key of `kind` on the attacker's contract. Tripped in the check and the simulation, never in a real transaction. */
async function run(key: Hex, kind: number, seconds: number) {
  await r.upsertPosition({ posId: `0x${"01".repeat(32)}`, owner: OWNER, adapter: BOOK, target: OWN, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [key] });
  // window = 2^32 - 1 seconds: AlarmBook accepts any DRAIN window of at least 1200 s.
  await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b, block) VALUES ($1,$2,$3,$4,$5,$6,$6,1)`, [key, kind, OWN, "2500", 4_294_967_295, ZERO]);
  const clock = { t: 100_000 };
  // The one sighting, recorded long ago (a real drop the attacker staged once, or a deposit they withdrew).
  const PENDING_AT = 1_000n;
  const sends: bigint[] = [];
  const d = {
    repo: r, alarmBook: BOOK, multicall3: BOOK, account: KEEPER, paidOnly: true, now: () => clock.t, quarantine: new Map<string, number>(), misses: new Map<string, number>(),
    client: {
      call: checkNode({ answer: () => true }),
      simulateCalls: async ({ calls }: { calls: { data: Hex }[] }) => {
        expect((decodeFunctionData({ abi: alarmBookAbi, data: calls[0]!.data }).args as [Hex])[0]).toBe(key);
        return { results: [{ status: "success", data: pokeResult(true), gasUsed: 1_000_000n, logs: [] }] };
      },
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "isLive") return false;
        if (functionName === "state") return [true, 0n, 0n, 0n, 0n, 0n, kind === Kind.DRAIN ? PENDING_AT : 0n] as const;
        throw new Error(functionName);
      },
    },
    send: async (tx: { gas: bigint }) => {
      sends.push(tx.gas);
      return TX;
    },
  } as unknown as KeeperDeps;
  for (const end = clock.t + seconds; clock.t < end; clock.t += 1) await pokeTripped(d);
  return { sends, d };
}

describe("V3-S04: an old DRAIN sighting makes every failed poke look like progress", () => {
  test("control: a SHARE_DROP key that never fires backs off, a handful of sends in an hour", async () => {
    const { sends, d } = await run(SHARE, Kind.SHARE_DROP, 3_600);
    expect(sends.length).toBeLessThanOrEqual(7);
    expect(d.misses!.get(SHARE.toLowerCase())).toBe(sends.length);
  });

  test("a DRAIN key with a sighting from a day ago is sent every 62 s: about 59 transactions an hour at 1.6M gas each", async () => {
    const { sends, d } = await run(DRAIN, Kind.DRAIN, 3_600);
    expect(sends.length).toBe(Math.ceil(3_600 / 62));
    expect(sends.every((g) => g === READ_GAS_FLOOR)).toBe(true);
    expect(d.misses!.size).toBe(0); // never counted as a miss
    expect(Number((await r.health(0)).counters.poke_pending)).toBe(sends.length);
  }, 60_000);
});
