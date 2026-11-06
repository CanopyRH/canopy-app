// The keeper's gas under attack. Its gas balance is what every honest exit needs, and anyone with a plan can arm
// positions and keys on contracts of their own. These used to make the keeper send without limit:
// - an exit from a vault whose redeem burns gas and never reduces the owner's balance, every 30 s for the alarm's 24 h,
//   with no gas limit on the transaction;
// - a checkpoint for every live SHARE_DROP key every hour, and an owed claim for every owed row every day.
// Now every send carries a gas limit from its own simulation, an unlisted vault's exit over its cap is refused, an exit
// that changes nothing backs off and ends, and checkpoints and claims are limited and capped per pass.
//
// Local mocks and the in-process database only.
import { beforeEach, describe, expect, test } from "bun:test";
import { encodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { Kind, presetsFor } from "../src/api/presets";
import { erc20Abi, routerAbi } from "../src/chain/abi";
import {
  ALARM_TTL, checkpointKeys, claimOwed, drainExits, limitFromSim, MAX_CHECKPOINTS_PER_PASS, MAX_OWED_PER_PASS, MAX_STRIKES, onFired,
  EXIT_SWAP_HEADROOM, READ_GAS_FLOOR, RETRY_SEC, SMALL_CALL_GAS, UNLISTED_EXIT_GAS, type KeeperDeps,
} from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const ROUTER = "0x00000000000000000000000000000000000000b0" as Address;
const KEEPER = "0x00000000000000000000000000000000000000b3" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address;
const LISTED = "0x00000000000000000000000000000000000000a1" as Address;
const HOSTILE = "0x00000000000000000000000000000000000e0001" as Address;
const ATTACKER = "0xabababababababababababababababababababab" as Address;
const KEY = `0x${"a1".repeat(32)}` as Hex;
const POS = `0x${"e1".repeat(32)}` as Hex;
const FIRED = 1_000;
const TX = `0x${"11".repeat(32)}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  await r.setPaidUntil(ATTACKER.toLowerCase(), 10_000_000); // one plan
});

const bal = (v: bigint) => encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: v });

/** One position on `target`, whose exit uses `burn` gas and whose balance only drops by `pays` per exit. */
async function exitScenario(target: Address, burn: bigint, pays = 0n) {
  await r.upsertPosition({ posId: POS, owner: ATTACKER.toLowerCase(), adapter: ROUTER, target: target.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [KEY] });
  let now = FIRED;
  let shares = 100n;
  const sends: { to: Address; gas?: bigint }[] = [];
  const d = {
    repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: ROUTER, morpho: ROUTER, account: KEEPER, paidOnly: true,
    listed: new Set([LISTED.toLowerCase()]), now: () => now,
    client: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "asset") return TOKEN;
        if (functionName === "balanceOf" || functionName === "allowance") return shares;
        throw new Error("not v2");
      },
      // The gate's view: the owner gains, the router and the keeper don't move. The exit uses `burn` gas.
      simulateCalls: async ({ calls }: { calls: { to: Address }[] }) => {
        const exitAt = calls.findIndex((c) => c.to.toLowerCase() === ROUTER.toLowerCase());
        return { results: calls.map((_, i) => (i === exitAt ? { status: "success", data: "0x", gasUsed: burn } : { status: "success", data: bal(i === exitAt + 1 ? 1n : 0n), gasUsed: 30_000n })) };
      },
    },
    send: async (tx: { to: Address; gas?: bigint }) => {
      sends.push(tx);
      shares = shares > pays ? shares - pays : 0n;
      return TX;
    },
  } as unknown as KeeperDeps;
  expect(await onFired(d, KEY, FIRED)).toBe(1);
  /** Runs the exits loop every RETRY_SEC for `sec` seconds. */
  const run = async (sec: number) => {
    for (const end = now + sec; now < end; now += RETRY_SEC) await drainExits(d);
  };
  return { d, sends, run };
}

const jobRow = async () => (await db.query<{ done: boolean; strikes: number; attempts: number }>(`SELECT done, strikes, attempts FROM jobs`))[0]!;

describe("exits from a vault built to burn the keeper's gas", () => {
  test("a 20M-gas exit from an unlisted vault is refused unsent, backs off, and ends", async () => {
    const { sends, run } = await exitScenario(HOSTILE, 20_000_000n);
    await run(ALARM_TTL);
    expect(sends).toEqual([]);
    expect(await jobRow()).toMatchObject({ done: true, strikes: MAX_STRIKES });
    expect(Number((await r.health(FIRED)).counters.exit_gas_refused)).toBe(MAX_STRIKES);
  });

  test("an exit under the cap that never moves the owner's balance is sent at most MAX_STRIKES times in 24 h, each with a simulated limit", async () => {
    const BURN = 1_000_000n;
    const { sends, run } = await exitScenario(HOSTILE, BURN);
    await run(3600);
    // Before: 120 an hour, 2,880 a day, each with no gas limit at all.
    expect(sends.length).toBe(MAX_STRIKES);
    expect(sends.every((s) => s.gas === limitFromSim(BURN) + EXIT_SWAP_HEADROOM)).toBe(true);
    await run(ALARM_TTL - 3600);
    expect(sends.length).toBe(MAX_STRIKES);
    expect(await jobRow()).toMatchObject({ done: true, strikes: MAX_STRIKES });
  });

  test("the backoff doubles: the second try waits a minute, the third two", async () => {
    const { sends, run } = await exitScenario(HOSTILE, 1_000_000n);
    const at: number[] = [];
    for (let t = 0; t < 600; t += RETRY_SEC) {
      const before = sends.length;
      await run(RETRY_SEC);
      if (sends.length > before) at.push(t);
    }
    expect(at.slice(0, 4)).toEqual([0, 60, 180, 420]);
  });

  test("an unlisted exit that pays out part each time keeps its normal retry", async () => {
    const { sends, run } = await exitScenario(HOSTILE, 300_000n, 10n);
    await run(10 * RETRY_SEC);
    expect(sends.length).toBe(10);
    expect(await jobRow()).toMatchObject({ done: true, strikes: 0 });
  });

  test("a listed vault keeps its fast retry, with no cap but the transaction limit", async () => {
    const { sends, run } = await exitScenario(LISTED, UNLISTED_EXIT_GAS * 2n);
    await run(10 * RETRY_SEC);
    expect(sends.length).toBe(10);
    expect(sends.every((s) => s.gas === limitFromSim(UNLISTED_EXIT_GAS * 2n) + EXIT_SWAP_HEADROOM)).toBe(true);
    expect((await jobRow()).strikes).toBe(0);
  });

  test("bundled exits from an unlisted vault over the cap are refused, not sent alone", async () => {
    // Eight positions in one vault, one key each, all fired: they would share a bundle.
    for (let i = 0; i < 8; i++) {
      await r.upsertPosition({ posId: `0x${"e2".repeat(31)}${i.toString(16).padStart(2, "0")}`, owner: ATTACKER.toLowerCase(), adapter: ROUTER, target: HOSTILE.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [KEY] });
    }
    const sends: unknown[] = [];
    const d = {
      repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: KEEPER, morpho: ROUTER, account: KEEPER, paidOnly: true,
      listed: new Set([LISTED.toLowerCase()]), now: () => FIRED,
      client: {
        multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => 100n),
        readContract: async ({ functionName }: { functionName: string }) => (functionName === "asset" ? TOKEN : 100n),
        simulateCalls: async ({ calls }: { calls: unknown[] }) => ({
          results: calls.map((_, i) => ({ status: "success", data: bal(i % 7 === 4 ? 1n : 0n), gasUsed: i % 7 === 3 ? 11_000_000n : 30_000n })),
        }),
      },
      send: async (tx: unknown) => void sends.push(tx),
    } as unknown as KeeperDeps;
    await onFired(d, KEY, FIRED);
    await drainExits(d);
    expect(sends).toEqual([]);
    const rows = await db.query<{ strikes: number; run_at: string }>(`SELECT strikes, run_at FROM jobs`);
    expect(rows).toHaveLength(8);
    expect(rows.every((x) => x.strikes === 1 && Number(x.run_at) > FIRED)).toBe(true);
  });
});

describe("checkpoints", () => {
  const k = (i: number) => `0x${"c"}${i.toString(16).padStart(63, "0")}` as Hex;
  const listedLoss = presetsFor(LISTED)[0]!; // "Vault loss", a SHARE_DROP preset

  async function setup(hostileKeys: number) {
    const keys = Array.from({ length: hostileKeys }, (_, i) => k(i));
    for (let i = 0; i < keys.length; i += 8) {
      await r.upsertPosition({ posId: `0x${"e"}${i.toString(16).padStart(63, "0")}`, owner: ATTACKER.toLowerCase(), adapter: ROUTER, target: HOSTILE, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: keys.slice(i, i + 8) });
    }
    for (const key of keys) await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,$2,$3,50,0,'0x','0x')`, [key, Kind.SHARE_DROP, HOSTILE.toLowerCase()]);
    // A paying user's listed-vault preset, registered after the attacker's.
    await r.setPaidUntil("0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", 10_000_000);
    await r.upsertPosition({ posId: `0x${"f".repeat(64)}`, owner: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", adapter: ROUTER, target: LISTED.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [listedLoss.key] });
    await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,$2,$3,50,0,'0x','0x')`, [listedLoss.key, Kind.SHARE_DROP, LISTED.toLowerCase()]);
  }

  function deps(o: { logs?: unknown[] } = {}) {
    const sends: { data: Hex; gas?: bigint }[] = [];
    const d = {
      repo: r, alarmBook: ROUTER, account: KEEPER, paidOnly: true, now: () => 1000, listed: new Set([LISTED.toLowerCase()]),
      client: {
        readContract: async () => ({ kind: Kind.SHARE_DROP, target: HOSTILE, window: 0 }),
        simulateCalls: async () => ({ results: [{ status: "success", data: "0x", gasUsed: 80_000n, logs: o.logs }] }),
      },
      send: async (tx: { data: Hex; gas?: bigint }) => {
        sends.push(tx);
        return TX;
      },
    } as unknown as KeeperDeps;
    return { d, sends };
  }
  const checkpointOf = (key: Hex) => encodeFunctionData({ abi: [{ type: "function", name: "checkpoint", inputs: [{ type: "bytes32" }], outputs: [], stateMutability: "nonpayable" }], functionName: "checkpoint", args: [key] });

  test("200 SHARE_DROP keys on one contract: the listed preset first, then at most the per-pass cap, each under a simulated limit", async () => {
    await setup(200);
    const { d, sends } = deps();
    await checkpointKeys(d, (await r.liveKeysOfKind(Kind.SHARE_DROP, 1000)) as Hex[]);
    // Before: 200 transactions in one hourly pass, none with a gas limit.
    expect(sends.length).toBe(1 + MAX_CHECKPOINTS_PER_PASS);
    expect(sends[0]!.data).toBe(checkpointOf(listedLoss.key));
    expect(sends.every((s) => s.gas === READ_GAS_FLOOR)).toBe(true);
  });

  test("the cap rotates, so every key is reached in time", async () => {
    await setup(60);
    const { d, sends } = deps();
    const live = (await r.liveKeysOfKind(Kind.SHARE_DROP, 1000)) as Hex[];
    for (let pass = 0; pass < 3; pass++) await checkpointKeys(d, live);
    expect(new Set(sends.map((s) => s.data)).size).toBe(61);
  });

  test("a SHARE_DROP checkpoint whose simulation moves no baseline isn't sent", async () => {
    await setup(8);
    const { d, sends } = deps({ logs: [] });
    await checkpointKeys(d, (await r.liveKeysOfKind(Kind.SHARE_DROP, 1000)) as Hex[]);
    expect(sends).toEqual([]);
  });

  test("a checkpoint that would use more than the cap isn't sent", async () => {
    await setup(8);
    const { d, sends } = deps();
    (d.client as unknown as { simulateCalls: unknown }).simulateCalls = async () => ({ results: [{ status: "success", data: "0x", gasUsed: SMALL_CALL_GAS + 1n }] });
    await checkpointKeys(d, (await r.liveKeysOfKind(Kind.SHARE_DROP, 1000)) as Hex[]);
    expect(sends).toEqual([]);
  });
});

describe("owed claims", () => {
  test("only owners with a live plan, a capped number per pass, each under a simulated limit", async () => {
    const paid = (i: number) => `0x${(0xa000 + i).toString(16).padStart(40, "0")}`;
    for (let i = 0; i < 50; i++) {
      await r.setPaidUntil(paid(i), 10_000_000);
      await r.addOwed(TX, i, paid(i), TOKEN, 5n);
    }
    for (let i = 0; i < 50; i++) await r.addOwed(TX, 100 + i, `0x${(0xb000 + i).toString(16).padStart(40, "0")}`, TOKEN, 5n); // no plan
    const sends: { data: Hex; gas?: bigint }[] = [];
    const d = {
      repo: r, router: ROUTER, account: KEEPER, paidOnly: true, now: () => 1000,
      client: {
        simulateContract: async () => ({}),
        simulateCalls: async () => ({ results: [{ status: "success", data: "0x", gasUsed: 60_000n }] }),
      },
      send: async (tx: { data: Hex; gas?: bigint }) => {
        sends.push(tx);
        return TX;
      },
    } as unknown as KeeperDeps;
    await claimOwed(d);
    expect(sends.length).toBe(MAX_OWED_PER_PASS);
    const paidCalls = new Set(Array.from({ length: 50 }, (_, i) => encodeFunctionData({ abi: routerAbi, functionName: "claimOwed", args: [paid(i) as Address, TOKEN] })));
    expect(sends.every((s) => paidCalls.has(s.data) && s.gas === limitFromSim(60_000n))).toBe(true);
  });
});
