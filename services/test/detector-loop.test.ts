// The detector's scan loop and the follow list, which anyone can add to through the bot.
// Local mocks and the in-process database only.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { handle, MAX_FOLLOWED_VAULTS } from "../src/bot/bot";
import { queueAlert, sendQueuedAlerts } from "../src/bot/queue";
import { scanAll, type ScanLoopDeps } from "../src/detectors/loop";
import { SNAP_KEEP_SEC } from "../src/detectors/scan";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const LISTED = "0x00000000000000000000000000000000000000c9";
const SLOW = "0x00000000000000000000000000000000000f0001";
const P = 10n ** 18n;
const addr = (i: number) => `0x${(0xf00000 + i).toString(16).padStart(40, "0")}`;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

describe("the scan loop", () => {
  function deps(paused: Set<string>, hang: Set<string>) {
    const queued: { vault: string; text: string }[] = [];
    const d: ScanLoopDeps = {
      repo: r, now: () => 1000, budgetMs: 50, withdrawInRobinhoodApp: false,
      vaultName: async (v) => (v === LISTED ? "Listed USDC" : v),
      queue: async (vault, text, tag) => {
        queued.push({ vault, text });
        await queueAlert(r, vault, text, 1000, tag);
      },
      client: {
        getCode: async ({ address }: { address: Address }) => {
          if (hang.has(address)) await new Promise(() => {});
          return "0x6001";
        },
        readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          if (functionName === "paused") return paused.has(address);
          if (functionName === "totalAssets") return 100n * P;
          if (functionName === "convertToAssets") return P;
          throw new Error("no such read");
        },
      } as never,
    };
    return { d, queued };
  }

  test("a contract that never answers costs one budget, and the vault after it is still scanned", async () => {
    const { d, queued } = deps(new Set([LISTED]), new Set([SLOW]));
    const t0 = performance.now();
    await scanAll(d, [SLOW, LISTED]);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(queued.map((q) => q.vault)).toEqual([LISTED]);
  });

  test("alerts are queued for the alerts loop, not sent from the scan", async () => {
    const telegram: string[] = [];
    const { d } = deps(new Set([LISTED]), new Set());
    await r.follow(1, LISTED);
    await scanAll(d, [LISTED]);
    expect(telegram).toEqual([]);
    expect(await r.dueJobs("alert", 1000)).toHaveLength(1);
    await sendQueuedAlerts(r, async (_vault, text) => void telegram.push(text), () => 1000);
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain("Listed USDC");
  });

  test("the same alert text a month later is a new alert", async () => {
    await queueAlert(r, LISTED, "paused", 1000, "PAUSED:1000");
    await queueAlert(r, LISTED, "paused", 1000 + 30 * 86_400, `PAUSED:${1000 + 30 * 86_400}`);
    expect(await r.dueJobs("alert", 1000 + 30 * 86_400)).toHaveLength(2);
  });
});

describe("following vaults", () => {
  test(`at most ${MAX_FOLLOWED_VAULTS} distinct vaults across all chats, refused politely`, async () => {
    for (let i = 0; i < MAX_FOLLOWED_VAULTS; i++) await r.follow(1000 + Math.floor(i / 20), addr(i));
    const refused = await handle(r, "https://x", 1, "watch", addr(MAX_FOLLOWED_VAULTS));
    expect(refused.text).toContain("can't add this one");
    expect(await r.followedTargets()).toBe(MAX_FOLLOWED_VAULTS);
    // A vault someone already follows, or a listed one, still can be.
    expect((await handle(r, "https://x", 1, "watch", addr(0))).text).toContain("Following");
    expect((await handle(r, "https://x", 1, "watch", LISTED, [LISTED])).text).toContain("Following");
  });
});

describe("vault readings", () => {
  test("readings older than the detectors' longest window are pruned", async () => {
    const now = 100 * 86_400;
    await r.recordSnap(LISTED, now - SNAP_KEEP_SEC - 1, P, P);
    await r.recordSnap(LISTED, now - SNAP_KEEP_SEC + 1, P, P);
    await r.pruneSnaps(now - SNAP_KEEP_SEC);
    expect((await r.snaps(LISTED, 0)).map((s) => s.t)).toEqual([now - SNAP_KEEP_SEC + 1]);
  });
});
