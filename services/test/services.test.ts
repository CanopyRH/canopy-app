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

  test("an LLM label alone never produces a signature", async () => {
    expect(await maybeAttest(a, BOOK, 8453, KEY, [feed], 100)).toBeNull();
  });
  test("soft + feed signs a short-lived attestation", async () => {
    const x = await maybeAttest(a, BOOK, 8453, KEY, [soft, feed], 100);
    expect(x?.signer).toBe(a.address);
    expect(x?.deadline).toBe(1200n);
  });
  test("two operators sign identical values despite different clocks and on-chain details", async () => {
    const otherDrain = { ...soft, value: 9, at: 2, evidence: "other operator's snapshot" };
    const x = await maybeAttest(a, BOOK, 8453, KEY, [soft, feed], 610);
    const y = await maybeAttest(b, BOOK, 8453, KEY, [otherDrain, { ...feed, at: 5 }], 1190);
    expect(x?.evidence).toBe(y!.evidence);
    expect(x?.deadline).toBe(y!.deadline);
  });
  test("different reports or different alarms never share evidence", () => {
    const other = { ...feed, evidence: "another report" };
    expect(sharedEvidence(KEY, [feed])).not.toBe(sharedEvidence(KEY, [other]));
    expect(sharedEvidence(KEY, [feed])).not.toBe(sharedEvidence(EV, [feed]));
  });
  test("recent labelled reports are rechecked, old ones are not", async () => {
    const c = async () => ({ label: "EXPLOIT_CONFIRMED" as const, protocol: "x", confidence: 0.95 });
    await ingestFeed(db, c, "u", "new", 5000);
    await ingestFeed(db, c, "u", "old", 100);
    await ingestFeed(db, async () => null, "u", "unlabelled", 5000);
    expect((await recentReports(db, 4000)).map((x) => x.classification.label)).toEqual(["EXPLOIT_CONFIRMED"]);
  });
  test("a feed item is only classified once", async () => {
    let calls = 0;
    const c = async () => (calls++, { label: "EXPLOIT_CONFIRMED" as const, protocol: "x", confidence: 0.95 });
    expect((await ingestFeed(db, c, "u", "text", 1))?.classification.label).toBe("EXPLOIT_CONFIRMED");
    expect(await ingestFeed(db, c, "u", "text", 2)).toBeNull();
    expect(calls).toBe(1);
  });
  test("reports match vaults by name, and short names match nothing", () => {
    const v = [{ name: "Steakhouse USDC" }, { name: "Gauntlet USDC Prime" }];
    expect(matchVaults("Steakhouse", v)).toEqual([v[0]!]);
    expect(matchVaults("gauntlet", v)).toEqual([v[1]!]);
    expect(matchVaults("x", v)).toEqual([]);
    expect(matchVaults("Unknown Protocol", v)).toEqual([]);
  });
  test("attestations need an approved signer, a valid signature and a live deadline", async () => {
    const list = [a.address, b.address];
    expect(await acceptAttestation(db, list, BOOK, 8453, await attest(a), 100)).toBe(true);
    expect(await acceptAttestation(db, list, BOOK, 8453, await attest(stranger), 100)).toBe(false);
    expect(await acceptAttestation(db, list, BOOK, 8453, { ...(await attest(stranger)), signer: a.address }, 100)).toBe(false);
    expect(await acceptAttestation(db, list, BOOK, 8453, await attest(a), 3000)).toBe(false);
  });
  test("quorum waits for two different signers", async () => {
    const list = [a.address, b.address];
    const t = { key: KEY, evidence: EV, deadline: 2000n };
    await acceptAttestation(db, list, BOOK, 8453, await attest(a), 100);
    await acceptAttestation(db, list, BOOK, 8453, await attest(a), 100);
    expect(await quorumCall(db, t, 2, BOOK)).toBeNull();
    await acceptAttestation(db, list, BOOK, 8453, await attest(b), 100);
    expect((await quorumCall(db, t, 2, BOOK))?.to).toBe(BOOK);
  });
});

describe("keeper plan filter", () => {
  const deps = (paidOnly: boolean, now = 1000): KeeperDeps => ({ repo: r, paidOnly, now: () => now } as never);
  const arm = (owner: string, id: string) => r.upsertPosition({ posId: id, owner, adapter: "x", target: V.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [KEY] });

  test("Canopy's keeper queues paid wallets only; an open keeper queues all", async () => {
    await arm("0xpaid", `0x${"01".repeat(32)}`);
    await arm("0xfree", `0x${"02".repeat(32)}`);
    await r.setPaidUntil("0xpaid", 5000);
    expect(await onFired(deps(true), KEY, 900)).toBe(1);
    expect(await onFired(deps(false), KEY, 901)).toBe(2);
  });
  test("an expired plan is skipped, and a re-queued alarm does not double up", async () => {
    await arm("0xold", `0x${"03".repeat(32)}`);
    await r.setPaidUntil("0xold", 999);
    expect(await onFired(deps(true), KEY, 900)).toBe(0);
    await onFired(deps(false), KEY, 902);
    await onFired(deps(false), KEY, 902);
    expect(await r.dueJobs("exit", 9999)).toHaveLength(1);
  });
});

describe("api", () => {
  const app = () => createApi({
    db, repo: r, vaults: async () => [{ address: V, name: "V", chainId: 8453, asset: "USDC" }], liveAlarms: async () => [],
    watchers: [a.address], alarmBook: BOOK, chainId: 8453, now: () => 100, telegram: async () => {}, telegramSecret: "s".repeat(16),
  });
});
