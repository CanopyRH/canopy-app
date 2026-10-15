import { beforeEach, describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { createApi } from "../src/api/server";
import { Kind, keyOf, presetsFor, registrationOrder } from "../src/api/presets";
import { appKeyboard, handle, notifyFollowers } from "../src/bot/bot";
import { claudeClassifier } from "../src/engine/classifier";
import { onFired, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { freshDb } from "./db";
import { repo, type Repo } from "../src/store/repo";
import { acceptAttestation, ingestFeed, matchVaults, maybeAttest, quorumCall, recentReports, sharedEvidence, type Attestation } from "../src/watcher/watcher";
import { signAttest } from "../src/watcher/attest";
import type { Signal } from "../src/detectors";

const V = "0x00000000000000000000000000000000000000c3" as Address;
const BOOK = "0x00000000000000000000000000000000000000aa" as Address;
const KEY = `0x${"22".repeat(32)}` as Hex;
const EV = `0x${"33".repeat(32)}` as Hex;
const a = privateKeyToAccount(`0x${"a1".padStart(64, "0")}`);
const b = privateKeyToAccount(`0x${"b2".padStart(64, "0")}`);
const stranger = privateKeyToAccount(`0x${"c3".padStart(64, "0")}`);

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

const attest = async (who = a, deadline = 2000n): Promise<Attestation> => ({
  key: KEY, evidence: EV, deadline, signer: who.address, sig: await signAttest(who, BOOK, 8453, KEY, EV, deadline),
});

const fake = (text: string, stop = "end_turn", capture?: (x: unknown) => void) => ({
  beta: { messages: { create: async (x: unknown) => (capture?.(x), { stop_reason: stop, content: [{ type: "text", text }] }) } },
}) as never;
