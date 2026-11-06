import { beforeEach, describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { registrationOrder, keyOf } from "../src/api/presets";
import { sameSecret } from "../src/api/secret";
import { ALERT_TRIES, queueAlert, sendQueuedAlerts } from "../src/bot/queue";
import { scrubUrls } from "../src/log";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { quorumScope } from "../src/watcher/scope";
import { freshDb } from "./db";

const OWNER = "0xabababababababababababababababababababab";
const LISTED = "0xbeeff033f34c046626b8d0a041844c5d1a5409dd" as Address;
const OTHER = "0x00000000000000000000000000000000000000e1" as Address;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

describe("logs never show an RPC key", () => {
  test("a URL keeps only its host", () => {
    expect(scrubUrls("request to https://lb.example.org/ogrpc?network=x&dkey=abc123 failed")).toBe("request to https://lb.example.org/… failed");
    expect(scrubUrls("URL: https://rpc.example.org/v1/abc123def")).toBe("URL: https://rpc.example.org/…");
    expect(scrubUrls("wss://user:pw@node.example.org/ws/abc")).toBe("wss://node.example.org/…");
    expect(scrubUrls("no url here")).toBe("no url here");
  });
});

describe("tokens are compared in constant time", () => {
  test("only the exact token passes", () => {
    expect(sameSecret("Bearer abc", "Bearer abc")).toBe(true);
    expect(sameSecret("Bearer abd", "Bearer abc")).toBe(false);
    expect(sameSecret("Bearer abcd", "Bearer abc")).toBe(false);
    expect(sameSecret(undefined, "Bearer abc")).toBe(false);
    expect(sameSecret("", "")).toBe(false);
  });
});

describe("alerts go out from their own queue", () => {
  test("each alert is sent once, even if queued twice", async () => {
    await queueAlert(r, LISTED, "hello", 100);
    await queueAlert(r, LISTED, "hello", 100);
    const sent: string[] = [];
    await sendQueuedAlerts(r, async (v, t) => sent.push(`${v}:${t}`), () => 100);
    await sendQueuedAlerts(r, async (v, t) => sent.push(`${v}:${t}`), () => 200);
    expect(sent).toEqual([`${LISTED}:hello`]);
  });

  test("a failed send is retried, then dropped after the last try", async () => {
    await queueAlert(r, LISTED, "hello", 0);
    let tries = 0;
    for (let t = 0; t < 1000; t += 30) await sendQueuedAlerts(r, async () => { tries++; throw new Error("telegram down"); }, () => t);
    expect(tries).toBe(ALERT_TRIES);
  });
});

describe("watcher alarms in scope", () => {
  const preset = keyOf(registrationOrder(LISTED).find((d) => d.kind === 5)!);
  const stranger = `0x${"5e".repeat(32)}`;
  const arm = async (key: string, paidUntil?: number) => {
    if (paidUntil !== undefined) await db.query(`INSERT INTO plans (wallet, paid_until) VALUES ($1,$2)`, [OWNER, paidUntil]);
    await r.upsertPosition({ posId: `0x${"01".repeat(32)}`, owner: OWNER, adapter: OTHER, target: OTHER, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "x", keys: [key] });
  };

  test("a listed vault's own preset is in scope, armed or not", async () => {
    expect(await quorumScope(r, [LISTED], () => 100, true)(preset, LISTED)).toBe(true);
  });

  test("an alarm on some other contract that nobody armed is not", async () => {
    expect(await quorumScope(r, [LISTED], () => 100, true)(stranger, OTHER)).toBe(false);
    expect(await quorumScope(r, [], () => 100, true)(preset, LISTED)).toBe(false);
  });

  test("an alarm a paid position armed is in scope, and an unpaid one only for an open keeper", async () => {
    await arm(stranger, 50);
    expect(await quorumScope(r, [LISTED], () => 100, true)(stranger, OTHER)).toBe(false);
    expect(await quorumScope(r, [LISTED], () => 100, false)(stranger, OTHER)).toBe(true);
    expect(await quorumScope(r, [LISTED], () => 10, true)(stranger, OTHER)).toBe(true);
  });
});
