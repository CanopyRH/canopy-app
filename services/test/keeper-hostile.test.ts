import { beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { drainExits, pokeTripped, QUARANTINE_SEC, SLOW_RETRY_SEC, type ExitJob, type KeeperDeps } from "../src/keeper/keeper";
import { deallocateCalls, MAX_MARKETS } from "../src/keeper/liquidity";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

// Arming is open to anyone, so these tests play an attacker who arms positions on contracts built to stall the keeper.
const OWNER = "0xabababababababababababababababababababab" as Address;
const BOOK = "0x00000000000000000000000000000000000000b0" as Address;
const LISTED = "0x00000000000000000000000000000000000000a1" as Address;
const HOSTILE = "0x00000000000000000000000000000000000000e1" as Address;
const TX = `0x${"11".repeat(32)}` as Hex;
const key = (b: string) => `0x${b.repeat(32)}` as Hex;
const never = () => new Promise<never>(() => {});

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

describe("a vault whose liquidity adapter claims endless markets", () => {
  test("gets no deallocation, after a few reads instead of an endless loop", async () => {
    let reads = 0;
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        reads++;
        if (functionName === "liquidityAdapter") return HOSTILE;
        if (functionName === "forceDeallocatePenalty") return 0n;
        if (functionName === "marketIdsLength") return 2n ** 255n;
        throw new Error(`the loop should not reach ${functionName}`);
      },
    };
    expect(await deallocateCalls(client as never, BOOK, HOSTILE, OWNER)).toEqual([]);
    expect(reads).toBe(3);
    expect(MAX_MARKETS).toBeLessThan(100n);
  });
});

describe("an exit that never finishes", () => {
  const job = (target: Address, n: string): ExitJob => ({ posId: key(n), key: key("cc"), owner: OWNER, target, firedAt: 1000 });

  test("runs out of time, waits longer, and doesn't stop the listed vault's exit", async () => {
    // The hostile job is queued first; the listed one must still run first and finish.
    await r.enqueue("exit", "hostile", job(HOSTILE, "01"), 1000);
    await r.enqueue("exit", "listed", job(LISTED, "02"), 1000);
    const order: string[] = [];
    const deps = {
      repo: r, router: BOOK, alarmBook: BOOK, multicall3: BOOK, morpho: BOOK, account: OWNER, paidOnly: false,
      now: () => 1000, jobBudgetMs: 50, listed: new Set([LISTED.toLowerCase()]),
      client: {
        readContract: async ({ address }: { address: Address }) => {
          order.push(address);
          if (address === HOSTILE) return never();
          return 0n; // The listed owner has nothing left to exit, so that job is done.
        },
      },
      send: async () => TX,
    } as unknown as KeeperDeps;

    const started = Date.now();
    await drainExits(deps);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(order[0]).toBe(LISTED);
    const rows = await db.query<{ dedupe: string; done: boolean; run_at: string }>(`SELECT dedupe, done, run_at FROM jobs ORDER BY dedupe`);
    expect(rows.map((x) => [x.dedupe, x.done, Number(x.run_at)])).toEqual([
      ["hostile", false, 1000 + SLOW_RETRY_SEC],
      ["listed", true, 1000],
    ]);
  });
});

describe("an alarm key that burns all the gas in the shared check", () => {
  const arm = async (pos: string, k: Hex) => {
    await r.upsertPosition({ posId: key(pos), owner: OWNER, adapter: BOOK, target: LISTED, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "x", keys: [k] });
  };
  const HONEST = key("a1");
  const BURNER = key("b2");
  const HONEST2 = key("c3");

  test("doesn't stop the honest keys around it, and is left out of the next shared check", async () => {
    for (const [pos, k] of [["01", HONEST], ["02", BURNER], ["03", HONEST2]] as const) await arm(pos, k);
    const sharedSizes: number[] = [];
    const poked: string[] = [];
    const quarantine = new Map<string, number>();
    const deps = {
      repo: r, alarmBook: BOOK, multicall3: BOOK, paidOnly: false, now: () => 1000, quarantine,
      client: {
        // The burner takes the gas, so every check in its request comes back failed.
        multicall: async ({ contracts }: { contracts: { args: Hex[] }[] }) => {
          sharedSizes.push(contracts.length);
          const sunk = contracts.some(({ args }) => args[0] === BURNER);
          return contracts.map(() => (sunk ? { status: "failure", error: new Error("out of gas") } : { status: "success", result: true }));
        },
        // On its own, each key gets the node's whole gas cap: honest keys answer, the burner still fails.
        readContract: async ({ args }: { args: Hex[] }) => {
          if (args[0] === BURNER) throw new Error("out of gas");
          return true;
        },
      },
      send: async (tx: { data: string }) => {
        poked.push(tx.data);
        return TX;
      },
    } as unknown as KeeperDeps;

    expect((await pokeTripped(deps)).sort()).toEqual([HONEST, HONEST2].sort());
    expect(quarantine.get(BURNER)).toBe(1000 + QUARANTINE_SEC);
    expect(await pokeTripped(deps)).toHaveLength(2);
    expect(sharedSizes).toEqual([3, 2]);
  });

  test("falls back to one check per key when the shared request fails outright", async () => {
    await arm("01", HONEST);
    const deps = {
      repo: r, alarmBook: BOOK, multicall3: BOOK, paidOnly: false, now: () => 1000, quarantine: new Map(),
      client: {
        multicall: async () => {
          throw new Error("gas cap reached");
        },
        readContract: async () => true,
      },
      send: async () => TX,
    } as unknown as KeeperDeps;
    expect(await pokeTripped(deps)).toEqual([HONEST]);
  });

  test("a quarantined key is checked again once its time is up", async () => {
    await arm("01", HONEST);
    const quarantine = new Map([[HONEST.toLowerCase(), 1500]]);
    let now = 1000;
    const deps = {
      repo: r, alarmBook: BOOK, multicall3: BOOK, paidOnly: false, now: () => now, quarantine,
      client: { multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ status: "success", result: true })) },
      send: async () => TX,
    } as unknown as KeeperDeps;
    expect(await pokeTripped(deps)).toEqual([]);
    now = 1500;
    expect(await pokeTripped(deps)).toEqual([HONEST]);
    expect(quarantine.size).toBe(0);
  });
});
