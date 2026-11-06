// What AlarmBook v2 changes for the keeper. A DRAIN key fires in two steps: the first poke that sees the drop only records
// it (Pending), and a poke DRAIN_CONFIRM seconds later fires it. Every read of a detector's target needs about 1.03M gas
// left, so a poke or checkpoint sent with a limit taken from a small simulation would revert NotEnoughGas.
//
// Local mocks and the in-process database only.
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, getAbiItem, toEventSelector, type Address, type Hex } from "viem";
import { alarmBookAbi } from "../src/chain/abi";
import { Kind } from "../src/api/presets";
import { checkpointKeys, DRAIN_CONFIRM_SEC, gasFor, pokeTripped, READ_GAS_FLOOR, SMALL_CALL_GAS, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { checkNode } from "./check-node";
import { freshDb } from "./db";

const BOOK = "0x00000000000000000000000000000000000000b0" as Address;
const KEEPER = "0x00000000000000000000000000000000000000b3" as Address;
const VAULT = "0x00000000000000000000000000000000000e0002" as Address;
const OWNER = "0xabababababababababababababababababababab";
const TX = `0x${"11".repeat(32)}` as Hex;
const DRAIN = `0x${"d1".repeat(32)}` as Hex;
const PENDING_TOPIC = toEventSelector(getAbiItem({ abi: alarmBookAbi, name: "Pending" }));
const pokeResult = (fired: boolean) => encodeFunctionResult({ abi: alarmBookAbi, functionName: "poke", result: fired });
let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  await r.setPaidUntil(OWNER, 10_000_000);
  await r.upsertPosition({ posId: `0x${"01".repeat(32)}`, owner: OWNER, adapter: BOOK, target: VAULT, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [DRAIN] });
  await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b, block) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [DRAIN, Kind.DRAIN, VAULT, "2500", 3600, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, "1"]);
});

/** A chain with one DRAIN key. The first poke records the drop; one at least DRAIN_CONFIRM s later fires. */
function chain(o: { logs: boolean; clock: { t: number } }) {
  const st = { pendingAt: 0n, firedAt: 0n, sends: [] as { data: Hex; gas?: bigint }[], simGas: [] as (bigint | undefined)[] };
  const canFire = () => st.pendingAt > 0n && BigInt(o.clock.t) >= st.pendingAt + BigInt(DRAIN_CONFIRM_SEC);
  const d = {
    repo: r, alarmBook: BOOK, multicall3: BOOK, account: KEEPER, paidOnly: true, now: () => o.clock.t, quarantine: new Map<string, number>(), misses: new Map<string, number>(),
    client: {
      // check(): true when a poke would make progress, false while a confirmation is pending and too young.
      call: checkNode({ answer: () => st.firedAt === 0n && (st.pendingAt === 0n || canFire()) }),
      simulateCalls: async ({ calls }: { calls: { data: Hex }[] }) => {
        const key = (decodeFunctionData({ abi: alarmBookAbi, data: calls[0]!.data }).args as [Hex])[0];
        expect(key).toBe(DRAIN);
        const fires = canFire();
        const logs = !fires && st.pendingAt === 0n ? [{ topics: [PENDING_TOPIC, DRAIN] }] : [];
        return { results: [{ status: "success", data: pokeResult(fires), gasUsed: 90_000n, ...(o.logs ? { logs } : {}) }] };
      },
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "isLive") return st.firedAt > 0n;
        if (functionName === "state") return [true, st.firedAt, 0n, 0n, 0n, 0n, st.pendingAt] as const;
        throw new Error(functionName);
      },
    },
    send: async (tx: { data: Hex; gas?: bigint }) => {
      st.sends.push(tx);
      if (canFire()) {
        st.firedAt = BigInt(o.clock.t);
        st.pendingAt = 0n;
      } else if (st.pendingAt === 0n) st.pendingAt = BigInt(o.clock.t);
      return TX;
    },
  } as unknown as KeeperDeps;
  return { d, st };
}

describe("a DRAIN key that fires in two pokes", () => {
  for (const logs of [true, false]) {
    test(`the first poke is progress, not a miss, and the second fires it (node ${logs ? "returns" : "gives no"} logs)`, async () => {
      const clock = { t: 1_000 };
      const { d, st } = chain({ logs, clock });
      expect(await pokeTripped(d)).toEqual([]); // recorded, not fired
      expect(st.sends).toHaveLength(1);
      expect(st.pendingAt).toBe(1_000n);
      // Not counted as a miss, and set aside until the confirmation can be poked, not for a miss's minute-plus.
      expect(d.misses!.size).toBe(0);
      expect(d.quarantine!.get(DRAIN.toLowerCase())).toBe(1_000 + DRAIN_CONFIRM_SEC + 2);
      expect(Number((await r.health(clock.t)).counters.poke_pending)).toBe(1);
      expect((await r.health(clock.t)).counters.poke_miss).toBeUndefined();

      // Inside the confirmation time nothing is sent.
      clock.t = 1_030;
      expect(await pokeTripped(d)).toEqual([]);
      expect(st.sends).toHaveLength(1);

      // Once it can be confirmed the key comes back, and this poke fires it.
      clock.t = 1_000 + DRAIN_CONFIRM_SEC + 2;
      expect(await pokeTripped(d)).toEqual([DRAIN]);
      expect(st.sends).toHaveLength(2);
      expect(st.firedAt).toBeGreaterThan(0n);
      expect(Number((await r.health(clock.t)).counters.poke_ok)).toBe(1);
    });
  }

  test("a poke that neither fires nor starts a confirmation is still a miss", async () => {
    const clock = { t: 1_000 };
    const { d, st } = chain({ logs: true, clock });
    // The drop was already pending and the confirmation is young, but the key still reads as tripped to the check.
    st.pendingAt = 990n;
    (d.client as unknown as { call: unknown }).call = checkNode({ answer: () => true });
    expect(await pokeTripped(d)).toEqual([]);
    expect(st.sends).toHaveLength(0); // the simulation said false with no Pending event, so nothing was sent
    expect(Number((await r.health(clock.t)).counters.poke_miss)).toBe(1);
    expect(d.misses!.get(DRAIN.toLowerCase())).toBe(1);
  });

  test("with no logs from the node, a DRAIN poke whose chain state shows no pending sighting is a miss", async () => {
    const clock = { t: 1_000 };
    const { d } = chain({ logs: false, clock });
    // The send lands but records nothing (the drop reads clear by then).
    (d as unknown as { send: unknown }).send = async () => TX;
    expect(await pokeTripped(d)).toEqual([]);
    expect(Number((await r.health(clock.t)).counters.poke_miss)).toBe(1);
    expect(d.quarantine!.get(DRAIN.toLowerCase())).toBe(1_000 + 60);
  });
});

describe("gas for calls that read a detector's target", () => {
  test("a poke is sent with at least the read floor, though its simulation used 90k", async () => {
    const clock = { t: 1_000 };
    const { d, st } = chain({ logs: true, clock });
    await pokeTripped(d);
    expect(st.sends[0]!.gas).toBe(READ_GAS_FLOOR);
    expect(READ_GAS_FLOOR).toBeGreaterThan(1_030_000n); // TARGET_READ_GAS plus AlarmBook's own overhead
  });

  test("a poke whose simulation used up to the cap still gets the floor, and one over the cap is refused", async () => {
    const { d } = chain({ logs: true, clock: { t: 1 } });
    const call = { to: BOOK, data: "0x" as Hex };
    const sim = (used: bigint) => ((d.client as unknown as { simulateCalls: unknown }).simulateCalls = async () => ({ results: [{ status: "success", data: "0x", gasUsed: used }] }));
    sim(900_000n);
    expect((await gasFor(d, call, SMALL_CALL_GAS, READ_GAS_FLOOR))!.gas).toBe(READ_GAS_FLOOR);
    sim(SMALL_CALL_GAS + 1n);
    expect(await gasFor(d, call, SMALL_CALL_GAS, READ_GAS_FLOOR)).toBeNull();
  });

  test("with no simulation the limit is still the floor, never lower", async () => {
    const { d } = chain({ logs: true, clock: { t: 1 } });
    (d.client as unknown as { simulateCalls: unknown }).simulateCalls = async () => {
      throw new Error("node can't simulate");
    };
    expect((await gasFor(d, { to: BOOK, data: "0x" }, SMALL_CALL_GAS, READ_GAS_FLOOR))!.gas).toBe(READ_GAS_FLOOR);
    expect((await gasFor(d, { to: BOOK, data: "0x" }, SMALL_CALL_GAS))!.gas).toBe(SMALL_CALL_GAS);
  });

  test("a checkpoint is sent with the floor too", async () => {
    const sends: { gas?: bigint }[] = [];
    const d = {
      repo: r, alarmBook: BOOK, account: KEEPER, paidOnly: false, now: () => 5_000,
      client: {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "detector") return { kind: Kind.SHARE_DROP, target: VAULT, threshold: 50n, window: 0, a: `0x${"00".repeat(32)}`, b: `0x${"00".repeat(32)}` };
          throw new Error(functionName);
        },
        simulateCalls: async () => ({ results: [{ status: "success", data: "0x", gasUsed: 80_000n, logs: [{ topics: [] }] }] }),
      },
      send: async (tx: { gas?: bigint }) => (sends.push(tx), TX),
    } as unknown as KeeperDeps;
    await checkpointKeys(d, [DRAIN]);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.gas).toBe(READ_GAS_FLOOR);
  });
});
