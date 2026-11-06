// Audit 2 PoCs A2-M3 and A2-H2 (second vector): keys whose read answer and real transaction differ.
//
// A2-M3: AlarmBook.check runs in eth_call, where tx.gasprice is 0. A PAUSED target can answer paused()=true only when
//        tx.gasprice == 0 and false in a real transaction. Then check() says "tripped" on every pass, the poke lands
//        without firing, nothing is quarantined (only a failed check is), and the keeper sends the same poke again a second
//        later. Each poke waits for its receipt on the one serial sender, so K such keys also add K receipt waits to
//        every poke pass, ahead of honest keys that sort after them.
// A2-H2b: checkpointKeys sends a checkpoint for every live SHARE_DROP key every hour, with no gas cap, and anyone may
//        register up to 9,999 SHARE_DROP keys per vault (one per threshold), on a contract whose reads burn gas.
//
// Local mocks and the in-process database only. Run: bun test test/audit2-poke-phantom.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { alarmBookAbi } from "../src/chain/abi";
import { pokeTripped, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const BOOK = "0x00000000000000000000000000000000000000b0" as Address;
const HOSTILE = "0x00000000000000000000000000000000000e0001" as Address;
const OWNER = "0xabababababababababababababababababababab";
const k = (tag: string, i: number) => `0x${tag}${i.toString(16).padStart(63, "0")}` as Hex;

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

describe("A2-M3: a key that trips only in eth_call is poked on every pass, forever", () => {
  test("20 phantom keys: 20 pokes per pass, none quarantined, and an honest poke waits behind their receipts", async () => {
    const phantom = Array.from({ length: 20 }, (_, i) => k("a", i));
    const HONEST = k("f", 1);
    await arm(phantom, "e");
    await arm([HONEST], "d");
    const RECEIPT_MS = 20; // stand-in for waiting on one receipt; seconds when the chain is busy
    const quarantine = new Map<string, number>();
    const pokes: Hex[] = [];
    let honestPokedAt = 0;
    let t0 = 0;
    const d = {
      repo: r, alarmBook: BOOK, multicall3: BOOK, paidOnly: true, now: () => 1000, quarantine,
      client: {
        // In eth_call (gas price 0) every one of these keys reads as tripped, the honest one too.
        multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ status: "success", result: true })),
      },
      send: async (tx: { data: Hex }) => {
        await Bun.sleep(RECEIPT_MS);
        const key = (decodeFunctionData({ abi: alarmBookAbi, data: tx.data }).args as [Hex])[0];
        pokes.push(key);
        if (key === HONEST && !honestPokedAt) honestPokedAt = performance.now() - t0;
        return `0x${"11".repeat(32)}` as Hex; // lands, but in a real transaction paused() is false, so nothing fires
      },
    } as unknown as KeeperDeps;

    // Put the honest key last, as liveKeys' unordered result may.
    const realLive = r.liveKeys.bind(r);
    (d.repo as Repo).liveKeys = async (p?: number) => [...(await realLive(p)).filter((x) => x !== HONEST), HONEST];

    t0 = performance.now();
    for (let pass = 0; pass < 5; pass++) await pokeTripped(d);
    const phantomPokes = pokes.filter((p) => p !== HONEST).length;
    console.log(`A2-M3: 5 passes -> ${phantomPokes} phantom pokes, quarantine ${quarantine.size}; honest key poked after ${honestPokedAt.toFixed(0)} ms (${phantom.length} x ${RECEIPT_MS} ms receipts ahead of it)`);
    expect(phantomPokes).toBe(5 * 20);
    expect(quarantine.size).toBe(0);
    expect(honestPokedAt).toBeGreaterThanOrEqual(20 * RECEIPT_MS * 0.9);
  });
});
