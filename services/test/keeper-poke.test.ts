// Alarm keys that answer the keeper's checks one way and its transactions another. Arming is open to anyone with a plan.
//
// - A key that burns gas only inside the shared check (the check runs one call frame deeper there, so the target can
//   read gasleft() and burn only then) passed when checked alone and was never quarantined. Every pass then fell back
//   to checking every live key one RPC at a time. Now a failed group is split in half until the key that sinks it is
//   found, and that key is left out even though it passes alone.
// - A key that reads as tripped in eth_call (where tx.gasprice is 0) but doesn't fire in a real transaction was poked
//   every second, forever. Now each poke is simulated at real fees first, the chain is asked afterwards whether it
//   fired, and a key that didn't is left out for a while, longer each time.
//
// The gas-selective target was checked in Foundry against the real AlarmBook at a 50M call cap:
//   contract Selective { uint256 immutable floor; constructor(uint256 f) { floor = f; }
//     function paused() external view returns (bool) { if (gasleft() < floor) { while (true) {} } return false; } }
// with floor = CAP * 63 / 64 - 400_000. AlarmBook.check(key) alone with CAP gas returned false; the same key first in a
// 250-key Multicall3 aggregate3 with CAP gas made the whole request fail (0 of 250 checks answered).
//
// Local mocks and the in-process database only.
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { alarmBookAbi } from "../src/chain/abi";
import { CHECKS_PER_CALL, MISS_QUARANTINE_SEC, pokeTripped, QUARANTINE_SEC, SPLIT_BELOW, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { checkNode, type CheckRequest } from "./check-node";
import { freshDb } from "./db";

const BOOK = "0x00000000000000000000000000000000000000b0" as Address;
const KEEPER = "0x00000000000000000000000000000000000000b3" as Address;
const HOSTILE = "0x00000000000000000000000000000000000e0001" as Address;
const OWNER = "0xabababababababababababababababababababab";
const TX = `0x${"11".repeat(32)}` as Hex;
const k = (tag: string, i: number) => `0x${tag}${i.toString(16).padStart(63, "0")}` as Hex;
const keyOfPoke = (data: Hex) => (decodeFunctionData({ abi: alarmBookAbi, data }).args as [Hex])[0];
const pokeResult = (fired: boolean) => encodeFunctionResult({ abi: alarmBookAbi, functionName: "poke", result: fired });

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  await r.setPaidUntil(OWNER, 10_000_000);
});

async function arm(keys: Hex[], pos: string) {
  for (let i = 0; i < keys.length; i += 8) {
    await r.upsertPosition({ posId: k(pos, i), owner: OWNER, adapter: BOOK, target: HOSTILE, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: keys.slice(i, i + 8) });
  }
}

describe("a key that trips only in eth_call", () => {
  const phantom = Array.from({ length: 20 }, (_, i) => k("a", i));
  const HONEST = k("f", 1);

  /** Every key reads as tripped. Only the honest one fires in a real transaction, or in a simulation at real fees. */
  function deps(o: { simulate: boolean; now: () => number }) {
    const quarantine = new Map<string, number>();
    const pokes: Hex[] = [];
    const simFees: unknown[] = [];
    const fired = new Set<Hex>();
    const d = {
      repo: r, alarmBook: BOOK, multicall3: BOOK, account: KEEPER, paidOnly: true, now: o.now, quarantine, misses: new Map(),
      fees: async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
      client: {
        call: checkNode({ answer: (key) => !fired.has(key) }),
        readContract: async ({ functionName, args }: { functionName: string; args: Hex[] }) => {
          if (functionName === "isLive") return fired.has(args[0]!);
          throw new Error(functionName);
        },
        ...(o.simulate
          ? {
              simulateCalls: async ({ calls }: { calls: { data: Hex; maxFeePerGas?: bigint }[] }) => {
                simFees.push(calls[0]!.maxFeePerGas);
                return { results: [{ status: "success", data: pokeResult(keyOfPoke(calls[0]!.data) === HONEST), gasUsed: 90_000n }] };
              },
            }
          : {}),
      },
      send: async (tx: { data: Hex }) => {
        const key = keyOfPoke(tx.data);
        pokes.push(key);
        if (key === HONEST) fired.add(key); // in a real transaction paused() is false for the others, so nothing fires
        return TX;
      },
    } as unknown as KeeperDeps;
    return { d, quarantine, pokes, simFees };
  }

  test("simulated at real fees, 20 phantom keys cost no transaction at all, and the honest one fires", async () => {
    await arm(phantom, "e");
    await arm([HONEST], "d");
    const { d, quarantine, pokes, simFees } = deps({ simulate: true, now: () => 1000 });
    const poked: Hex[][] = [];
    for (let pass = 0; pass < 5; pass++) poked.push(await pokeTripped(d));
    // Before: 100 phantom pokes in 5 passes, none quarantined.
    expect(pokes).toEqual([HONEST]);
    expect(poked[0]).toEqual([HONEST]);
    expect(quarantine.size).toBe(20);
    expect(simFees.every((f) => f === 2_000_000_000n)).toBe(true);
  });

  test("with no simulation, each phantom key is poked once, then left out for longer each time", async () => {
    await arm(phantom, "e");
    await arm([HONEST], "d");
    let now = 1000;
    const { d, quarantine, pokes } = deps({ simulate: false, now: () => now });
    for (let pass = 0; pass < 5; pass++) await pokeTripped(d);
    expect(pokes.filter((p) => p !== HONEST)).toHaveLength(20);
    expect(pokes.filter((p) => p === HONEST)).toHaveLength(1);
    expect(quarantine.get(phantom[0]!)).toBe(1000 + MISS_QUARANTINE_SEC);
    // Back after its time, misses again, and stays out twice as long.
    now = 1000 + MISS_QUARANTINE_SEC;
    await pokeTripped(d);
    expect(pokes.filter((p) => p !== HONEST)).toHaveLength(40);
    expect(quarantine.get(phantom[0]!)).toBe(now + 2 * MISS_QUARANTINE_SEC);
    // At most an hour, however often it misses.
    for (let i = 0; i < 10; i++) {
      now = quarantine.get(phantom[0]!)!;
      await pokeTripped(d);
    }
    expect(quarantine.get(phantom[0]!)! - now).toBe(6 * QUARANTINE_SEC);
  });
});

describe("a key that burns gas only inside the shared check", () => {
  const key = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as Hex;
  const SELECTIVE = `0x${"5b".repeat(32)}` as Hex;
  const PLAIN = `0x${"b2".repeat(32)}` as Hex;

  async function armAll(keys: Hex[]) {
    for (let i = 0; i < keys.length; i += 8) {
      await r.upsertPosition({ posId: key(10_000 + i), owner: OWNER, adapter: BOOK, target: HOSTILE, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: keys.slice(i, i + 8) });
    }
  }

  function deps(burner: Hex, quarantine: Map<string, number>, counts: { shared: number; alone: number }) {
    return {
      repo: r, alarmBook: BOOK, multicall3: BOOK, paidOnly: false, now: () => 1000, quarantine,
      client: {
        call: checkNode({
          seen: { push: (q: CheckRequest) => void (q.shared ? counts.shared++ : counts.alone++) },
          // A burner in a shared request takes the gas, so every check in that request fails.
          answer: (key, req) => {
            if (req.shared && req.keys.includes(burner)) return "revert";
            if (!req.shared && key === PLAIN) return "revert"; // a plain burner fails alone too
            return false; // the selective one answers false alone, like every honest key that hasn't tripped
          },
        }),
      },
      send: async () => TX,
    } as unknown as KeeperDeps;
  }

  test("a plain burner among 300 keys is found by splitting, not by 301 single checks", async () => {
    await armAll([...Array.from({ length: 300 }, (_, i) => key(i + 1)), PLAIN]);
    const q = new Map<string, number>();
    const counts = { shared: 0, alone: 0 };
    await pokeTripped(deps(PLAIN, q, counts));
    expect([...q.keys()]).toEqual([PLAIN]);
    expect(counts.alone).toBeLessThan(SPLIT_BELOW);
    expect(counts.shared).toBeLessThan(25);
    counts.alone = 0;
    counts.shared = 0;
    await pokeTripped(deps(PLAIN, q, counts));
    expect(counts).toEqual({ shared: Math.ceil(300 / CHECKS_PER_CALL), alone: 0 });
  });

  test("a selective burner is left out after one pass, though it passes alone, and later passes are one shared request", async () => {
    await armAll([...Array.from({ length: 300 }, (_, i) => key(i + 1)), SELECTIVE]);
    const q = new Map<string, number>();
    const counts = { shared: 0, alone: 0 };
    await pokeTripped(deps(SELECTIVE, q, counts));
    expect([...q.keys()]).toEqual([SELECTIVE]);
    expect(q.get(SELECTIVE)).toBe(1000 + QUARANTINE_SEC);
    // Before: 301 single checks on this pass and every pass after.
    expect(counts.alone).toBeLessThan(SPLIT_BELOW);
    for (let pass = 0; pass < 4; pass++) {
      counts.alone = 0;
      counts.shared = 0;
      await pokeTripped(deps(SELECTIVE, q, counts));
      expect(counts).toEqual({ shared: Math.ceil(300 / CHECKS_PER_CALL), alone: 0 });
    }
  });

  test("a check that failed once by chance doesn't get an honest key left out", async () => {
    const honest = Array.from({ length: 3 }, (_, i) => key(i + 1));
    await armAll(honest);
    const q = new Map<string, number>();
    let first = true;
    const d = {
      repo: r, alarmBook: BOOK, multicall3: BOOK, paidOnly: false, now: () => 1000, quarantine: q,
      client: {
        call: checkNode({
          answer: () => false,
          refuse: () => {
            const blip = first;
            first = false;
            return blip;
          },
        }),
      },
      send: async () => TX,
    } as unknown as KeeperDeps;
    await pokeTripped(d);
    expect(q.size).toBe(0);
  });
});
