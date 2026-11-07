// Your own alarm levels: a user picks how far the share price must fall (0.5%, 1%, 2%, 5% or 10%) before a "Vault loss"
// alarm exits them. The level is a plain SHARE_DROP detector built the way the preset is, so its key is deterministic.
//
// The keeper treats a level on a LISTED vault, armed by a paid position, like a preset: it pokes it, checkpoints it and
// exits it. These tests pin that, and pin that nothing was loosened for anyone else:
// - the set of level keys per vault is fixed at five, so an attacker cannot mint "listed" keys by choosing thresholds;
// - a level on an unlisted vault, or armed by an unpaid wallet, is treated like any other attacker key.
//
// Local mocks and the in-process database only.
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import {
  armablePresets, DEFAULT_LEVEL_BPS, isLevelBps, isLevelKey, isOwnKey, levelDetector, levelDetectors, levelLabel, levelPreset, levelPresets, LEVELS_BPS,
} from "../src/api/levels";
import { isPreset, keyOf, Kind, presetsFor, registrationOrder } from "../src/api/presets";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import { checkpointKeys, drainExits, MAX_CHECKPOINTS_PER_PASS, onFired, pokeTripped, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { quorumScopeNow } from "../src/watcher/scope";
import { checkNode } from "./check-node";
import { freshDb } from "./db";

const LISTED = "0x00000000000000000000000000000000000000a1" as Address;
const UNLISTED = "0x00000000000000000000000000000000000e0001" as Address;
const ROUTER = "0x00000000000000000000000000000000000000b0" as Address;
const MC3 = "0x00000000000000000000000000000000000000b2" as Address;
const KEEPER = "0x00000000000000000000000000000000000000b3" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address;
const PAID = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const ATTACKER = "0xabababababababababababababababababababab"; // also on a plan: anyone can pay
const UNPAID = "0xefefefefefefefefefefefefefefefefefefefef";
const TX = `0x${"11".repeat(32)}` as Hex;
const b32 = (tag: string, i: number) => `0x${tag}${i.toString(16).padStart(64 - tag.length, "0")}` as Hex;
const hostile = (i: number) => `0x00000000000000000000000000000000000e${(i + 16).toString(16).padStart(4, "0")}` as Address;

const level = (bps: number) => levelPreset(LISTED, bps as never).key;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  await r.setPaidUntil(PAID, 10_000_000);
  await r.setPaidUntil(ATTACKER, 10_000_000);
});

const detector = (key: Hex, target: Address, threshold: number, kind: number = Kind.SHARE_DROP) =>
  db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,$2,$3,$4,0,'0x','0x')`, [key, kind, target.toLowerCase(), threshold]);
const position = (posId: Hex, owner: string, target: Address, keys: Hex[]) =>
  r.upsertPosition({ posId, owner, adapter: ROUTER, target: target.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys });

describe("the level keys", () => {
  test("there are five levels, 0.5%, 1%, 2%, 5% and 10%, and each reads as a percentage", () => {
    expect([...LEVELS_BPS]).toEqual([50, 100, 200, 500, 1000]);
    expect(LEVELS_BPS.map(levelLabel)).toEqual(["0.5%", "1%", "2%", "5%", "10%"]);
  });

  test("a level is a SHARE_DROP detector on the vault, built field for field like the Vault loss preset", () => {
    const preset = presetsFor(LISTED).find((p) => p.name === "Vault loss")!;
    expect(levelDetector(LISTED, DEFAULT_LEVEL_BPS)).toEqual(preset.detector);
    expect(levelPreset(LISTED, DEFAULT_LEVEL_BPS).key).toBe(preset.key);
    for (const bps of LEVELS_BPS) {
      const d = levelDetector(LISTED, bps);
      expect(d).toMatchObject({ kind: Kind.SHARE_DROP, target: LISTED, threshold: BigInt(bps), window: 0 });
      expect(keyOf(d)).toBe(level(bps));
    }
  });

  test("keys are fixed values, so they match the Solidity test that registers the same detectors", () => {
    // The same constants are hard-coded in contracts/test/AlarmLevels.t.sol, for vault 0x...a1 on the default test chain.
    expect(LEVELS_BPS.map(level)).toEqual(LEVEL_KEYS);
  });

  test("the five keys are different, and different on another vault", () => {
    const other = levelPresets(UNLISTED).map((p) => p.key);
    const mine = levelPresets(LISTED).map((p) => p.key);
    expect(new Set(mine).size).toBe(5);
    expect(mine.some((k) => other.includes(k))).toBe(false);
  });

  test("only the five listed numbers are levels. Anything else throws, so the app can never build another key", () => {
    for (const bps of [0, 1, 49, 51, 75, 150, 2_500, 9_999, 10_000, -50, 0.5]) {
      expect(isLevelBps(bps)).toBe(false);
      expect(() => levelDetector(LISTED, bps)).toThrow(/not an alarm level/);
    }
  });

  test("the keys are worked out from the vault and the list alone, with no network", () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("the key must not come from a server"); }) as never;
    try {
      expect(levelPresets(LISTED)).toHaveLength(5);
      expect(armablePresets(LISTED, presetsFor(LISTED))).toHaveLength(presetsFor(LISTED).length + 4);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("armable alarms are the presets plus the four levels the presets lack, and nothing is listed twice", () => {
    const all = armablePresets(LISTED, presetsFor(LISTED));
    expect(new Set(all.map((p) => p.key)).size).toBe(all.length);
    for (const bps of LEVELS_BPS) expect(all.some((p) => p.key === level(bps))).toBe(true);
    expect(levelDetectors(LISTED).map(keyOf)).toEqual(LEVELS_BPS.map(level));
  });

  test("levels add no DRAIN detector, and every DRAIN the app registers keeps its window of 1,200 seconds or more", () => {
    expect(levelDetectors(LISTED).every((d) => d.kind === Kind.SHARE_DROP && d.window === 0)).toBe(true);
    const drains = registrationOrder(LISTED).filter((d) => d.kind === Kind.DRAIN);
    expect(drains.length).toBeGreaterThan(0);
    for (const d of drains) expect(d.window).toBeGreaterThanOrEqual(1_200);
  });

  test("a vault's own key is a preset, a part of one, or one of its five levels, and nothing else", () => {
    for (const d of registrationOrder(LISTED)) expect(isOwnKey(LISTED, keyOf(d))).toBe(true);
    for (const bps of LEVELS_BPS) expect(isOwnKey(LISTED, level(bps))).toBe(true);
    // The same detector with a threshold off the list, or on another vault, is just another key.
    const off = keyOf({ ...levelDetector(LISTED, 100), threshold: 101n });
    expect(isOwnKey(LISTED, off)).toBe(false);
    expect(isLevelKey(LISTED, off)).toBe(false);
    expect(isOwnKey(LISTED, levelPreset(UNLISTED, 100).key)).toBe(false);
    expect(isPreset(LISTED, level(100))).toBe(false); // the preset test alone still doesn't know levels
    expect(isLevelKey(LISTED, level(100).toUpperCase().replace("0X", "0x"))).toBe(true);
  });
});

describe("checkpoints: a paid level on a listed vault is never starved", () => {
  const checkpointOf = (key: Hex) => encodeFunctionData({ abi: alarmBookAbi, functionName: "checkpoint", args: [key] });

  function deps(o: { paidOnly?: boolean } = {}) {
    const sends: Hex[] = [];
    const d = {
      repo: r, alarmBook: ROUTER, account: KEEPER, paidOnly: o.paidOnly ?? true, now: () => 1000, listed: new Set([LISTED.toLowerCase()]),
      client: {
        readContract: async () => ({ kind: Kind.SHARE_DROP, target: UNLISTED, window: 0 }),
        simulateCalls: async () => ({ results: [{ status: "success", data: "0x", gasUsed: 80_000n, logs: [{}] }] }),
      },
      send: async (tx: { data: Hex }) => {
        sends.push(tx.data);
        return TX;
      },
    } as unknown as KeeperDeps;
    return { d, sends };
  }
  const live = async (paidOnly = true) => (await r.liveKeysOfKind(Kind.SHARE_DROP, paidOnly ? 1000 : undefined)) as Hex[];

  /** Paid attackers arming SHARE_DROP keys in bulk: on their own contracts, and with off-list thresholds on the listed vault. */
  async function flood(tag: string, count: number, target: Address, thresholdFrom = 51) {
    const keys: Hex[] = [];
    for (let i = 0; i < count; i += 8) {
      const part = Array.from({ length: Math.min(8, count - i) }, (_, j) => b32(tag, i + j));
      for (const [j, key] of part.entries()) await detector(key, target, thresholdFrom + i + j);
      await position(b32(`e${tag}`, i), ATTACKER, target, part);
      keys.push(...part);
    }
    return keys;
  }

  test("a 2% level behind 80 never-checkpointed attacker keys is still sent on the first pass", async () => {
    const key = level(200);
    await detector(key, LISTED, 200);
    await flood("c1", 50, UNLISTED);
    await flood("c2", 30, LISTED); // off-list thresholds on the listed vault itself
    // The paid user arms after the flood, the order that used to leave it behind.
    await position(b32("f", 1), PAID, LISTED, [key]);
    const { d, sends } = deps();
    await checkpointKeys(d, await live());
    expect(sends[0]).toBe(checkpointOf(key));
    expect(sends.length).toBe(1 + MAX_CHECKPOINTS_PER_PASS); // the cap on everything else is untouched
  });

  test("the same on every later pass, while the attacker keeps adding fresh keys", async () => {
    const key = level(500);
    await detector(key, LISTED, 500);
    await position(b32("f", 2), PAID, LISTED, [key]);
    for (let pass = 0; pass < 3; pass++) {
      await flood(`d${pass}`, 40, UNLISTED);
      const { d, sends } = deps();
      await checkpointKeys(d, await live());
      expect(sends.filter((s) => s === checkpointOf(key))).toHaveLength(1);
      expect(sends.length).toBe(1 + MAX_CHECKPOINTS_PER_PASS);
    }
  });

  test("all five levels and the preset are sent together, ahead of the cap, and the cap still applies to the rest", async () => {
    const keys = LEVELS_BPS.map(level);
    for (const [i, bps] of LEVELS_BPS.entries()) await detector(keys[i]!, LISTED, bps);
    await flood("c3", 60, UNLISTED);
    await position(b32("f", 3), PAID, LISTED, keys);
    const { d, sends } = deps();
    await checkpointKeys(d, await live());
    expect(sends.slice(0, 5).sort()).toEqual(keys.map(checkpointOf).sort());
    expect(sends.length).toBe(5 + MAX_CHECKPOINTS_PER_PASS);
  });

  test("a level on a vault Canopy doesn't list gets no priority: 25 such levels share the cap with every other key", async () => {
    const vaults = Array.from({ length: 25 }, (_, i) => hostile(i));
    for (const [i, v] of vaults.entries()) {
      const key = levelPreset(v, 100).key;
      await detector(key, v, 100);
      await position(b32("e9", i), ATTACKER, v, [key]);
    }
    const { d, sends } = deps();
    await checkpointKeys(d, await live());
    expect(sends.length).toBe(MAX_CHECKPOINTS_PER_PASS);
  });

  test("an off-list threshold on the listed vault gets no priority either: 25 of them share the cap", async () => {
    await flood("c4", 25, LISTED, 101);
    const { d, sends } = deps();
    await checkpointKeys(d, await live());
    expect(sends.length).toBe(MAX_CHECKPOINTS_PER_PASS);
  });

  test("a level armed only by a wallet with no plan is not a live key, so the paid-only keeper never sends it", async () => {
    const key = level(1000);
    await detector(key, LISTED, 1000);
    await position(b32("f", 4), UNPAID, LISTED, [key]);
    const { d, sends } = deps();
    expect(await live()).toEqual([]);
    await checkpointKeys(d, await live());
    expect(sends).toEqual([]);
    // An open keeper, which runs every armed position, does take it.
    const open = deps({ paidOnly: false });
    await checkpointKeys(open.d, await live(false));
    expect(open.sends).toEqual([checkpointOf(key)]);
  });
});

describe("pokes: a paid level is poked among hostile keys", () => {
  const keyOfPoke = (data: Hex) => (decodeFunctionData({ abi: alarmBookAbi, data }).args as [Hex])[0];

  /** `sinks` keys fail every check, as a contract that burns gas would. The level's key reads as tripped. */
  function deps(tripped: Set<Hex>, sinks: Set<Hex>) {
    const fired = new Set<Hex>();
    const pokes: Hex[] = [];
    const d = {
      repo: r, alarmBook: ROUTER, multicall3: MC3, account: KEEPER, paidOnly: true, now: () => 1000, quarantine: new Map<string, number>(), misses: new Map<string, number>(),
      client: {
        // The keeper's checks are eth_calls: a shared request that holds a sink fails whole, and a sink alone fails too.
        call: checkNode({
          answer: (key, req) => {
            if (req.shared ? req.keys.some((k) => sinks.has(k)) : sinks.has(key)) return "revert";
            return tripped.has(key) && !fired.has(key);
          },
        }),
        readContract: async ({ functionName, args }: { functionName: string; args: Hex[] }) => {
          if (functionName === "isLive") return fired.has(args[0]!);
          throw new Error(functionName);
        },
      },
      send: async (tx: { data: Hex }) => {
        pokes.push(keyOfPoke(tx.data));
        fired.add(keyOfPoke(tx.data));
        return TX;
      },
    } as unknown as KeeperDeps;
    return { d, pokes };
  }

  test("300 attacker keys, 25 of them built to sink the shared check: the 1% level on the listed vault still fires and is poked", async () => {
    const key = level(100);
    await detector(key, LISTED, 100);
    const junk = Array.from({ length: 300 }, (_, i) => b32("a", i));
    for (let i = 0; i < junk.length; i += 8) await position(b32("e", i), ATTACKER, UNLISTED, junk.slice(i, i + 8));
    await position(b32("f", 5), PAID, LISTED, [key]);
    const { d, pokes } = deps(new Set([key]), new Set(junk.slice(0, 25)));
    expect(await pokeTripped(d)).toEqual([key]);
    expect(pokes).toEqual([key]);
  });

  test("a tripped level armed only by a wallet with no plan is not poked by the paid-only keeper", async () => {
    const key = level(100);
    await detector(key, LISTED, 100);
    await position(b32("f", 6), UNPAID, LISTED, [key]);
    const { d, pokes } = deps(new Set([key]), new Set());
    expect(await pokeTripped(d)).toEqual([]);
    expect(pokes).toEqual([]);
  });
});

describe("exits: a paid level on a listed vault exits ahead of attacker jobs", () => {
  const exitOf = (data: Hex) => (decodeFunctionData({ abi: routerAbi, data }).args as unknown as [Hex])[0];
  const bal = (v: bigint) => encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: v });
  const FIRED = 1_000;

  function deps(left: Map<string, bigint>, owners: Map<Hex, string>) {
    const sent: Hex[] = [];
    const d = {
      repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: MC3, morpho: ROUTER, account: KEEPER, paidOnly: true,
      listed: new Set([LISTED.toLowerCase()]), now: () => FIRED + 60,
      client: {
        multicall: async ({ contracts }: { contracts: { address: Address }[] }) => contracts.map((c) => left.get(c.address.toLowerCase()) ?? 100n),
        readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          if (functionName === "asset") return TOKEN;
          if (functionName === "balanceOf" || functionName === "allowance") return left.get(address.toLowerCase()) ?? 100n;
          throw new Error(`${functionName} is not a Vault V2 read here`);
        },
        simulateCalls: async ({ calls }: { calls: { to: Address; data: Hex }[] }) => ({
          results: calls.map((c, i) => {
            if (c.to.toLowerCase() === ROUTER.toLowerCase()) return { status: "success", data: "0x" as Hex, gasUsed: 300_000n };
            const afterExit = i > 0 && calls[i - 1]!.to.toLowerCase() === ROUTER.toLowerCase();
            return { status: "success", data: bal(afterExit ? 1n : 0n), gasUsed: 30_000n };
          }),
        }),
      },
      send: async (tx: { to: Address; data: Hex }) => {
        const pos = exitOf(tx.data);
        sent.push(pos);
        const target = owners.get(pos);
        if (target) left.set(target, 0n);
        return TX;
      },
    } as unknown as KeeperDeps;
    return { d, sent };
  }

  /** Fires `key` on the listed vault for the paid user, after 40 attacker exits on vaults of their own were queued. */
  async function scenario(key: Hex, ownerOfKey: string) {
    await detector(key, LISTED, 200);
    const left = new Map<string, bigint>();
    const targets = new Map<Hex, string>();
    const { d, sent } = deps(left, targets);
    for (let i = 0; i < 40; i++) {
      const posId = b32("e", i);
      targets.set(posId, hostile(i).toLowerCase());
      await position(posId, ATTACKER, hostile(i), [b32("a", i)]);
      await onFired(d, b32("a", i), FIRED);
    }
    const victimPos = b32("f", 7);
    targets.set(victimPos, LISTED.toLowerCase());
    await position(victimPos, ownerOfKey, LISTED, [key]);
    expect(await onFired(d, key, FIRED + 30)).toBe(ownerOfKey === PAID ? 1 : 0); // an unpaid wallet is never queued
    return { d, sent, victimPos };
  }

  test("a fired 2% level queues the paid owner's exit, and it is the first transaction of the first pass", async () => {
    const { d, sent, victimPos } = await scenario(level(200), PAID);
    await drainExits(d);
    expect(sent[0]).toBe(victimPos);
  });

  test("the listed loop runs it alone, whatever the other vaults have queued", async () => {
    const { d, sent, victimPos } = await scenario(level(200), PAID);
    await drainExits(d, "listed");
    expect(sent).toEqual([victimPos]);
  });

  test("a SHARE_DROP key an attacker minted on the listed vault (threshold off the list) gets no listed treatment, even from a paid wallet", async () => {
    const minted = keyOf({ ...levelDetector(LISTED, 100), threshold: 101n });
    expect(isOwnKey(LISTED, minted)).toBe(false);
    const { d, sent, victimPos } = await scenario(minted, PAID);
    await drainExits(d, "listed");
    expect(sent).toEqual([]); // the listed loop does not run it
    for (let pass = 0; pass < 3; pass++) await drainExits(d, "unlisted"); // behind the other owner-chosen keys, as any such job is
    expect(sent).toContain(victimPos);
  });

  test("an unpaid wallet's level is never queued by the paid-only keeper", async () => {
    const { d, sent, victimPos } = await scenario(level(200), UNPAID);
    await drainExits(d, "listed");
    expect(sent).not.toContain(victimPos);
    expect(sent).toEqual([]);
  });
});

describe("watcher scope is unchanged by levels", () => {
  test("a level key is not in scope for a watcher alarm unless a paid position armed it, like any other key", async () => {
    const key = level(100);
    await detector(key, LISTED, 100);
    const listed = [LISTED.toLowerCase()];
    expect((await quorumScopeNow(r, listed, () => 1000, true))(key, LISTED.toLowerCase())).toBe(false);
    await position(b32("f", 8), UNPAID, LISTED, [key]);
    expect((await quorumScopeNow(r, listed, () => 1000, true))(key, LISTED.toLowerCase())).toBe(false);
    await position(b32("f", 9), PAID, LISTED, [key]);
    expect((await quorumScopeNow(r, listed, () => 1000, true))(key, LISTED.toLowerCase())).toBe(true);
  });
});

/** Keys of the five levels on vault 0x00000000000000000000000000000000000000a1, smallest first. */
const LEVEL_KEYS: Hex[] = [
  "0x84f4dce8ed924d647e512e672afe1e47a1f105835ca9fe67b93d8559a81ea06a",
  "0xb6aff78865f81b8cd7322ec7b5df76c257e365c46d3a74ff1e95f73bce5cae3d",
  "0x2abbf22a211c2fd82e8c6c4d50c0af6d64ffe4e0a835718ae15a740be2829dbb",
  "0x093b229c333e41f4291fcd109d5dd03d85bce6e87d54008fa9149a63b9c87bd6",
  "0x3c8d401d8db337ea7a94fad4aacb28f5adc65b39a437b958bd7f862c9d5cb411",
];
