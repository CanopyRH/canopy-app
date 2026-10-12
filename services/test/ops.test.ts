import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { multicall3Abi, routerAbi } from "../src/chain/abi";
import { BASE, chainParts, ROBINHOOD, txUrl } from "../src/chain/addresses";
import { handle, notifyText } from "../src/bot/bot";
import { ALARM_NAMES, signalLine, watchAlert } from "../src/copy/alerts";
import { createApi } from "../src/api/server";
import { isPreset, keyOf, registrationOrder } from "../src/api/presets";
import { drainVelocity } from "../src/detectors";
import { scanVault } from "../src/detectors/scan";
import { Env, loadEnv } from "../src/env";
import { applyRouterLog, syncLogs, type Log } from "../src/indexer/indexer";
import { BUNDLE_GAS, claimOwed, drainExits, pokeTripped, runExit, type ExitJob, type KeeperDeps } from "../src/keeper/keeper";
import { serialSender, withMargin } from "../src/keeper/sender";
import { opsProblems } from "../src/keeper/ops";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { feedItems } from "../src/watcher/feeds";
import { ingestFeed, isHighS, matchVaults, recentReports } from "../src/watcher/watcher";
import { findBanned } from "../../tools/banned-words";
import { freshDb } from "./db";

const V = "0x00000000000000000000000000000000000000c3" as Address;
const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const TX = `0x${"44".repeat(32)}` as Hex;
const POS = `0x${"11".repeat(32)}` as Hex;
const KEY = `0x${"22".repeat(32)}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

interface Chain { code?: string; totalAssets: bigint; price: bigint; paused?: boolean | "none"; owner?: Address; curator?: Address }
