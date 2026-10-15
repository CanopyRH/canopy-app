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

describe("classifier", () => {
  test("uses structured output and returns a valid label", async () => {
    let req: { model?: string; output_config?: { format: { type: string } } } = {};
    const c = claudeClassifier(fake('{"label":"EXPLOIT_CONFIRMED","protocol":"x","confidence":0.9}', "end_turn", (x) => (req = x as typeof req)));
    expect((await c("s", "t"))?.label).toBe("EXPLOIT_CONFIRMED");
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.output_config?.format.type).toBe("json_schema");
  });
  test("sends Anthropic's fallback settings only when calling Anthropic directly", async () => {
    const ok = '{"label":"IRRELEVANT","protocol":"x","confidence":0.1}';
    let req: { model?: string; betas?: string[]; fallbacks?: string } = {};
    await claudeClassifier(fake(ok, "end_turn", (x) => (req = x as typeof req)))("s", "t");
    expect(req.fallbacks).toBe("default");
    await claudeClassifier(fake(ok, "end_turn", (x) => (req = x as typeof req)), "claude-opus-5.5", false)("s", "t");
    expect(req.model).toBe("claude-opus-5.5");
    expect(req.fallbacks).toBeUndefined();
    expect(req.betas).toBeUndefined();
  });
  test("a refusal, bad JSON or an API failure produces nothing", async () => {
    expect(await claudeClassifier(fake('{"label":"EXPLOIT_CONFIRMED","protocol":"x","confidence":1}', "refusal"))("s", "t")).toBeNull();
    expect(await claudeClassifier(fake("not json"))("s", "t")).toBeNull();
    const broken = { beta: { messages: { create: async () => { throw new Error("down"); } } } } as never;
    expect(await claudeClassifier(broken)("s", "t")).toBeNull();
  });
});

describe("watcher", () => {
  const soft: Signal = { kind: "DRAIN", target: V, severity: "soft", value: 1, at: 1, evidence: "e" };
  const feed: Signal = { kind: "FEED_EXPLOIT_CONFIRMED", target: V, severity: "soft", value: 1, at: 1, evidence: "e" };
});
