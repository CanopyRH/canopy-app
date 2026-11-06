// The deployment verifier's failure cases. A fake chain that matches the tested build and the intended settings passes
// every check; each test then breaks one thing and the matching check must fail. Without contracts/out the build is made
// with forge, or the tests skip and say why (see forge.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, PublicClient } from "viem";
import type { Deployment, Settings } from "../deploy/plan";
import { ALARM_BOOK_CONSTANTS, domainSeparator, ROUTER_CONSTANTS, verifyDeployment, type Check } from "../deploy/verify";
import { contractsBuilt, OUT } from "./forge";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const D: Deployment = { timelock: A(1), alarmBook: A(2), router: A(3), adapter: A(4), startBlock: 100 };
const S: Settings = {
  chainId: 4663, proposer: A(5), guardian: A(6), stable: A(7), weth: A(8), swapRouter: A(9), stableFeed: A(10), heartbeat: 90_000,
  adminExpiry: 2_000_000_000, watchers: [A(11), A(12), A(13)], vaults: [A(0x51)],
};
const YEAR = 365n * 86_400n;
const SINCE = 1_500n;
const build = contractsBuilt();

const runtime = (file: string) => (JSON.parse(readFileSync(join(OUT, file), "utf8")) as { deployedBytecode: { object: string } }).deployedBytecode.object;

interface World {
  /** Replaces what a read of `name` on `address` returns. */
  reads: Map<string, unknown>;
  code: Map<string, string>;
  adapterLogs: { adapter: Address; allowed: boolean }[];
  watcherLogs: { watcher: Address; until: bigint }[];
}

/** A chain on which the deployment is exactly right. */
function good(): World {
  const reads = new Map<string, unknown>();
  const set = (address: Address, name: string, v: unknown) => reads.set(`${address.toLowerCase()}:${name}`, v);
  set(D.timelock, "PROPOSER", S.proposer);
  set(D.timelock, "DELAY", 0n);
  set(D.alarmBook, "ADMIN", D.timelock);
  set(D.alarmBook, "DOMAIN_SEPARATOR", domainSeparator(S.chainId, D.alarmBook));
  for (const [n, v] of Object.entries(ALARM_BOOK_CONSTANTS)) set(D.alarmBook, n, v);
  for (const w of S.watchers) {
    set(D.alarmBook, `isWatcher:${w.toLowerCase()}`, true);
    set(D.alarmBook, `watcherSince:${w.toLowerCase()}`, SINCE);
    set(D.alarmBook, `watcherUntil:${w.toLowerCase()}`, SINCE + YEAR);
  }
  set(D.router, "ADMIN", D.timelock);
  set(D.router, "ALARMS", D.alarmBook);
  set(D.router, "guardian", S.guardian);
  set(D.router, "STABLE", S.stable);
  set(D.router, "WETH", S.weth);
  set(D.router, "SWAP_ROUTER", S.swapRouter);
  set(D.router, "STABLE_FEED", S.stableFeed);
  set(D.router, "STABLE_FEED_HEARTBEAT", S.heartbeat);
  set(D.router, "ADMIN_EXPIRY", S.adminExpiry);
  set(D.router, "armingPaused", false);
  set(D.router, `adapterAllowed:${D.adapter.toLowerCase()}`, true);
  for (const [n, v] of Object.entries(ROUTER_CONSTANTS)) set(D.router, n, v);
  set(D.adapter, "ROUTER", D.router);
  const code = new Map<string, string>([
    [D.timelock, runtime("Timelock.sol/Timelock.json")],
    [D.alarmBook, runtime("AlarmBook.sol/AlarmBook.json")],
    [D.router, runtime("ExitRouter.sol/ExitRouter.json")],
    [D.adapter, runtime("ERC4626Adapter.sol/ERC4626Adapter.json")],
    [S.proposer, "0x6001"],
    [S.guardian, "0x6001"],
  ].map(([a, c]) => [(a as string).toLowerCase(), c as string]));
  return { reads, code, adapterLogs: [{ adapter: D.adapter, allowed: true }], watcherLogs: S.watchers.map((w) => ({ watcher: w, until: SINCE + YEAR })) };
}

function clientOf(w: World, chainTime = { start: 1_000n, now: 2_000n }): PublicClient {
  return {
    getCode: async ({ address }: { address: Address }) => w.code.get(address.toLowerCase()) ?? "0x",
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) => {
      const base = `${address.toLowerCase()}:${functionName}`;
      const key = args && args.length > 0 ? `${base}:${String(args[0]).toLowerCase()}` : base;
      if (w.reads.has(key)) return w.reads.get(key);
      if (w.reads.has(base)) return w.reads.get(base);
      throw new Error(`no such read ${key}`);
    },
    getLogs: async ({ event }: { event: { name: string } }) =>
      event.name === "AdapterSet" ? w.adapterLogs.map((l) => ({ args: l })) : w.watcherLogs.map((l) => ({ args: { watcher: l.watcher, until: l.until } })),
    getBlock: async (a?: { blockNumber?: bigint }) => ({ timestamp: a?.blockNumber !== undefined ? chainTime.start : chainTime.now }),
  } as unknown as PublicClient;
}

const failed = (checks: Check[]) => checks.filter((c) => !c.ok).map((c) => c.name);
const run = (w: World, s: Settings = S) => verifyDeployment(clientOf(w), D, s);

describe.skipIf(!build.ok)("verifyDeployment", () => {
  test("control: a deployment that is exactly right passes every check", async () => {
    const checks = await run(good());
    expect(failed(checks)).toEqual([]);
    expect(checks.length).toBeGreaterThan(50);
  });

  test("wrong bytecode: a router that is not the tested build fails, and so does an AlarmBook with a changed byte", async () => {
    const w = good();
    const router = w.code.get(D.router.toLowerCase())!;
    // Flip a byte well inside the code (outside the immutable slots, which are blanked before comparing).
    const at = Math.floor(router.length / 2);
    w.code.set(D.router.toLowerCase(), `${router.slice(0, at)}${router[at] === "0" ? "1" : "0"}${router.slice(at + 1)}`);
    expect(failed(await run(w))).toEqual(["ExitRouter bytecode matches the tested build"]);

    const v = good();
    v.code.set(D.alarmBook.toLowerCase(), "0x6001");
    expect(failed(await run(v))).toContain("AlarmBook bytecode matches the tested build");
    const none = good();
    none.code.delete(D.adapter.toLowerCase());
    expect(failed(await run(none))).toContain("ERC4626Adapter bytecode matches the tested build");
  });

  test("wrong watcher list: an extra approved watcher, a missing one, and a different term all fail", async () => {
    const extra = good();
    extra.watcherLogs.push({ watcher: A(99), until: SINCE + YEAR });
    expect(failed(await run(extra))).toEqual(["No watcher beyond the intended ones"]);

    const removed = good();
    removed.reads.set(`${D.alarmBook.toLowerCase()}:isWatcher:${A(12).toLowerCase()}`, false);
    expect(failed(await run(removed))).toEqual([`Watcher ${A(12).slice(0, 8)} is active`]);

    const short = good();
    short.reads.set(`${D.alarmBook.toLowerCase()}:watcherUntil:${A(11).toLowerCase()}`, SINCE + YEAR - 1n);
    expect(failed(await run(short))).toEqual([`Watcher ${A(11).slice(0, 8)} is approved for 365 days`]);

    const late = good();
    late.reads.set(`${D.alarmBook.toLowerCase()}:watcherSince:${A(13).toLowerCase()}`, SINCE + 5n);
    late.reads.set(`${D.alarmBook.toLowerCase()}:watcherUntil:${A(13).toLowerCase()}`, SINCE + 5n + YEAR);
    expect(failed(await run(late))).toEqual(["Every watcher started in the same transaction"]);

    // A watcher removed again (until 0) is not "beyond the intended ones".
    const gone = good();
    gone.watcherLogs.push({ watcher: A(99), until: SINCE + YEAR }, { watcher: A(99), until: 0n });
    expect(failed(await run(gone))).toEqual([]);
  });

  test("wrong adapter: not allowed, a second allowed one, or wired to another router", async () => {
    const off = good();
    off.reads.set(`${D.router.toLowerCase()}:adapterAllowed:${D.adapter.toLowerCase()}`, false);
    off.adapterLogs = [];
    expect(failed(await run(off))).toEqual(["Adapter is allowed from deployment", "The adapter is the only allowed adapter"]);

    const two = good();
    two.adapterLogs.push({ adapter: A(77), allowed: true });
    expect(failed(await run(two))).toEqual(["The adapter is the only allowed adapter"]);

    const other = good();
    other.reads.set(`${D.adapter.toLowerCase()}:ROUTER`, A(0x99));
    expect(failed(await run(other))).toEqual(["Adapter is wired to this router"]);
  });

  test("wrong constants: each changed constant fails by name", async () => {
    const book = good();
    book.reads.set(`${D.alarmBook.toLowerCase()}:DRAIN_CONFIRM`, 30n);
    book.reads.set(`${D.alarmBook.toLowerCase()}:TARGET_READ_GAS`, 500_000n);
    expect(failed(await run(book))).toEqual(["AlarmBook TARGET_READ_GAS", "AlarmBook DRAIN_CONFIRM"]);

    const router = good();
    router.reads.set(`${D.router.toLowerCase()}:MAX_KEYS`, 16n);
    router.reads.set(`${D.router.toLowerCase()}:STABLE_FLOOR_BPS`, 9_000n);
    expect(failed(await run(router))).toEqual(["Router MAX_KEYS", "Router STABLE_FLOOR_BPS"]);
  });

  test("wrong chain: a signing domain for another chain or another AlarmBook fails", async () => {
    const chain = good();
    chain.reads.set(`${D.alarmBook.toLowerCase()}:DOMAIN_SEPARATOR`, domainSeparator(8453, D.alarmBook));
    expect(failed(await run(chain))).toEqual(["AlarmBook signing domain is version 2 on this chain"]);
    const book = good();
    book.reads.set(`${D.alarmBook.toLowerCase()}:DOMAIN_SEPARATOR`, domainSeparator(S.chainId, A(0x1234)));
    expect(failed(await run(book))).toEqual(["AlarmBook signing domain is version 2 on this chain"]);
  });

  test("wrong settings on the live contracts: admin, guardian, stablecoin and swap router", async () => {
    const w = good();
    w.reads.set(`${D.router.toLowerCase()}:ADMIN`, A(0x42));
    w.reads.set(`${D.router.toLowerCase()}:guardian`, A(0x43));
    w.reads.set(`${D.router.toLowerCase()}:STABLE`, A(0x44));
    w.reads.set(`${D.router.toLowerCase()}:SWAP_ROUTER`, A(0x45));
    expect(failed(await run(w))).toEqual(["Router admin is the Timelock", "Router guardian", "Router stablecoin", "Router swap router"]);
  });

  test("a multisig that is a plain wallet fails on mainnet, and a test Timelock or plain-wallet admin is refused there", async () => {
    const w = good();
    w.code.delete(S.proposer.toLowerCase());
    expect(failed(await run(w))).toEqual(["Multisig proposer is a contract"]);
    expect(failed(await run(good(), { ...S, allowEoaAdmin: true }))).toContain("Plain-wallet admins are refused on mainnet");
  });

  test("a router that still carries a removed function fails", async () => {
    const w = good();
    // setFeed(address,address,uint32,uint8)
    w.code.set(D.router.toLowerCase(), `${w.code.get(D.router.toLowerCase())}${"00".repeat(4)}`);
    const names = failed(await run(w));
    expect(names).toContain("ExitRouter bytecode matches the tested build");
  });
});
