import { beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { Kind } from "../src/api/presets";
import { adminChanges } from "../src/detectors";
import { checkpointKeys, type KeeperDeps } from "../src/keeper/keeper";
import { reachableAssets } from "../src/keeper/liquidity";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { allowedFeed, feedItems, fetchFeed } from "../src/watcher/feeds";
import { freshDb } from "./db";

const BOTH = `0x${"aa".repeat(32)}` as Hex;
const DRAIN = `0x${"bb".repeat(32)}` as Hex;
const QUORUM = `0x${"cc".repeat(32)}` as Hex;
const OTHER = `0x${"dd".repeat(32)}` as Hex;
const V = "0x00000000000000000000000000000000000000c3" as Hex;
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";

describe("combined alarms", () => {
  let db: Db;
  let r: Repo;
  const detector = (key: Hex, kind: number, a = "", b = "") =>
    db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,$2,$3,0,0,$4,$5)`, [key, kind, V, a, b]);
  const arm = (posId: Hex, keys: Hex[]) =>
    r.upsertPosition({ posId, owner: A, adapter: B, target: V, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "x", keys });

  beforeEach(async () => {
    db = await freshDb();
    r = repo(db);
    await detector(DRAIN, Kind.DRAIN);
    await detector(QUORUM, Kind.QUORUM);
    await detector(BOTH, Kind.BOTH, DRAIN, QUORUM);
    await detector(OTHER, Kind.DRAIN);
  });

  test("an armed BOTH key brings its parts with it, or it could never fire", async () => {
    await arm(`0x${"01".repeat(32)}`, [BOTH]);
    expect((await r.liveKeys()).sort()).toEqual([BOTH, DRAIN, QUORUM].sort());
  });
});
