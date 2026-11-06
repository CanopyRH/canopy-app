import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Log, PublicClient } from "viem";
import { CONFIG, type Chain } from "../src/config";
import { ADMIN_REFS, CANNOT, FACT_NAMES, LIMITS_COPY, WATCHER_REFS, type SourceRef } from "../src/copy/limits";
import {
  countdown, delayText, getLogsSplit, headline, loadLimits, parseAdapterLogs, parseWatcherLogs, shortAddress, sourceLinks, tweetText, tweetUrl,
  utcDate, utcDay, watcherRows, watcherState, chainNow, DAY,
} from "../src/limits";
import { findBanned } from "../../tools/banned-words";

const ROUTER = CONFIG.router!, BOOK = CONFIG.alarmBook!;
const ADAPTER = "0x32C39abF03a12303Cc3150be50eD7b0e03Ab9D38" as Address;
const EXPIRY = 1_825_286_400; // 4 November 2027, 00:00 UTC, as read from the live router

// Raw logs from Robinhood Chain (4663), taken from the deploy block range with eth_getLogs.
const raw = (address: string, topics: string[], data: string, blockNumber: bigint, logIndex: number) => ({ address, topics, data, blockNumber, logIndex }) as unknown as Log;
const ADAPTER_SET = raw(ROUTER, ["0x85ff5d10aa202e69f691155a2050fed648b2d67f85e35d1279510cc434023736", "0x00000000000000000000000032c39abf03a12303cc3150be50ed7b0e03ab9d38"], "0x0000000000000000000000000000000000000000000000000000000000000001", 0x66bf315n, 0);
const WATCHER_TOPIC = "0xfa171717ed1df6c092eb007ffeee8370c9ba027620068e628d884406d2ee3c03";
const TERM = "0x000000000000000000000000000000000000000000000000000000006aee0776000000000000000000000000000000000000000000000000000000006ccf3af6";
const W1 = "0x8b644F28278c0f219212b9200f538873d03875Ec" as Address, W2 = "0xB3a99F3d5A0C8636F41914faa6F594a2bd1C9A2d" as Address, W3 = "0x38Fde12F818Cc841765cD08641EaC2201868fc51" as Address;
const topicOf = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const WATCHER_SET = [W1, W2, W3].map((w, i) => raw(BOOK, [WATCHER_TOPIC, topicOf(w)], TERM, 0x66bf30bn, 0xb + i));
const SINCE = 0x6aee0776, UNTIL = 0x6ccf3af6;

describe("countdown", () => {
  test("whole days, hours and minutes, rounded down", () => {
    const c = countdown(EXPIRY, EXPIRY - (363 * DAY + 5 * 3600 + 7 * 60 + 59));
    expect(c).toMatchObject({ ended: false, days: 363, hours: 5, minutes: 7 });
    expect(headline(c)).toBe("Admin powers end in 363 days");
  });
  test("one day is singular, and the last day counts hours then minutes", () => {
    expect(headline(countdown(EXPIRY, EXPIRY - DAY))).toBe("Admin powers end in 1 day");
    expect(headline(countdown(EXPIRY, EXPIRY - (DAY - 1)))).toBe("Admin powers end in 23 hours");
    expect(headline(countdown(EXPIRY, EXPIRY - 3600))).toBe("Admin powers end in 1 hour");
    expect(headline(countdown(EXPIRY, EXPIRY - 119))).toBe("Admin powers end in 1 minute");
    expect(headline(countdown(EXPIRY, EXPIRY - 59))).toBe("Admin powers end in less than a minute");
  });
  test("at the expiry second and after, the powers have ended (the contract's test is now >= expiry)", () => {
    expect(countdown(EXPIRY, EXPIRY).ended).toBe(true);
    expect(countdown(EXPIRY, EXPIRY + 10_000)).toMatchObject({ ended: true, days: 0, seconds: 0 });
    expect(headline(countdown(EXPIRY, EXPIRY))).toBe("Admin powers have ended");
    expect(countdown(EXPIRY, EXPIRY - 1).ended).toBe(false);
  });
  test("the exact date is printed in UTC the same way everywhere", () => {
    expect(utcDate(EXPIRY)).toBe("4 November 2027, 00:00 UTC");
    expect(utcDate(1_793_984_374)).toBe("6 November 2026, 16:59 UTC");
    expect(utcDay(SINCE)).toBe("6 Nov 2026");
    expect(utcDay(UNTIL)).toBe("6 Nov 2027");
  });
  test("the chain's clock wins over a wrong device clock", () => {
    const limits = { clockOffset: { ok: true as const, value: 3 * DAY } };
    expect(chainNow(limits, 1000)).toBe(1000 + 3 * DAY);
    expect(chainNow({ clockOffset: { ok: false } }, 1000)).toBe(1000);
  });
  test("delay in words", () => {
    expect(delayText(0)).toBe("None");
    expect(delayText(2 * DAY)).toBe("2 days");
    expect(delayText(DAY)).toBe("1 day");
    expect(delayText(7200)).toBe("2 hours");
    expect(delayText(90 * 60)).toBe("90 minutes");
    expect(shortAddress(ADAPTER)).toBe("0x32C3…9D38");
  });
});

describe("post on X", () => {
  test("says the number of days, the way it was asked for", () => {
    expect(tweetText(countdown(EXPIRY, EXPIRY - 363 * DAY - 100))).toBe("Canopy's admin powers end in 363 days. After that nobody can change the exit contract. canopyrh.com/limits");
    expect(tweetText(countdown(EXPIRY, EXPIRY - DAY))).toBe("Canopy's admin powers end in 1 day. After that nobody can change the exit contract. canopyrh.com/limits");
  });
  test("under a day it says so, and after the date it speaks in the past tense", () => {
    expect(tweetText(countdown(EXPIRY, EXPIRY - 5000))).toContain("in less than a day");
    expect(tweetText(countdown(EXPIRY, EXPIRY + 1))).toBe("Canopy's admin powers have ended. Nobody can change the exit contract. canopyrh.com/limits");
  });
  test("the link carries the text, encoded", () => {
    const url = new URL(tweetUrl("a b & c"));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("text")).toBe("a b & c");
  });
});

describe("events to lists", () => {
  test("the real AdapterSet log gives the one allowed adapter", () => {
    expect(parseAdapterLogs([ADAPTER_SET], ROUTER)).toEqual([{ adapter: ADAPTER, allowed: true }]);
  });
  test("the last word wins, whatever order the logs arrive in", () => {
    const off = raw(ROUTER, ADAPTER_SET.topics as string[], "0x" + "0".repeat(64), 0x66bf400n, 3);
    expect(parseAdapterLogs([off, ADAPTER_SET], ROUTER)).toEqual([{ adapter: ADAPTER, allowed: false }]);
    expect(parseAdapterLogs([ADAPTER_SET, off], ROUTER)).toEqual([{ adapter: ADAPTER, allowed: false }]);
    // Allowed again later in the same block: the higher log index wins.
    const on = raw(ROUTER, ADAPTER_SET.topics as string[], ADAPTER_SET.data, 0x66bf400n, 4);
    expect(parseAdapterLogs([on, off], ROUTER)).toEqual([{ adapter: ADAPTER, allowed: true }]);
  });
  test("logs from another contract or another event are ignored", () => {
    expect(parseAdapterLogs([{ ...ADAPTER_SET, address: "0x00000000000000000000000000000000000000a1" } as Log], ROUTER)).toEqual([]);
    expect(parseAdapterLogs(WATCHER_SET, ROUTER)).toEqual([]);
    expect(parseAdapterLogs([], ROUTER)).toEqual([]);
  });
  test("the three launch watchers come out once each, in order", () => {
    expect(parseWatcherLogs(WATCHER_SET, BOOK)).toEqual([W1, W2, W3]);
    expect(parseWatcherLogs([...WATCHER_SET, ...WATCHER_SET].reverse(), BOOK)).toEqual([W1, W2, W3]);
    expect(parseWatcherLogs([ADAPTER_SET], BOOK)).toEqual([]);
  });
  test("a removed watcher has since 0 and is left out, the rest are listed by start", () => {
    const rows = watcherRows([
      { watcher: W3, since: 0n, until: 0n },
      { watcher: W2, since: BigInt(SINCE + 100), until: BigInt(UNTIL) },
      { watcher: W1, since: BigInt(SINCE), until: BigInt(UNTIL) },
    ]);
    expect(rows).toEqual([{ watcher: W1, since: SINCE, until: UNTIL }, { watcher: W2, since: SINCE + 100, until: UNTIL }]);
  });
  test("a watcher waits, is active, then expires at the end second", () => {
    const w = { since: SINCE, until: UNTIL };
    expect(watcherState(w, SINCE - 1)).toBe("waiting");
    expect(watcherState(w, SINCE)).toBe("active");
    expect(watcherState(w, UNTIL - 1)).toBe("active");
    expect(watcherState(w, UNTIL)).toBe("expired");
    // The launch approvals last one year, which is the contract's longest term.
    expect(UNTIL - SINCE).toBe(365 * DAY);
  });
});

describe("log ranges", () => {
  const log = (n: number) => ({ blockNumber: BigInt(n) }) as unknown as Log;
  test("a node that takes the whole range is asked once", async () => {
    let calls = 0;
    const out = await getLogsSplit(async (a, b) => (calls++, [log(Number(a))]), 10n, 99n);
    expect(calls).toBe(1);
    expect(out.length).toBe(1);
  });
  test("a node that refuses a big range gets halves, and nothing is lost or doubled", async () => {
    const all = Array.from({ length: 40 }, (_, i) => i + 100);
    const out = await getLogsSplit(async (a, b) => {
      if (b - a > 10n) throw new Error("range too large");
      return all.filter((n) => BigInt(n) >= a && BigInt(n) <= b).map(log);
    }, 100n, 139n);
    expect(out.map((l) => Number(l.blockNumber))).toEqual(all);
  });
  test("it gives up rather than show half a history", async () => {
    await expect(getLogsSplit(async () => { throw new Error("down"); }, 0n, 1_000_000n)).rejects.toThrow();
    await expect(getLogsSplit(async () => [], 0n, 10n, { left: 0 })).rejects.toThrow();
    expect(await getLogsSplit(async () => [log(1)], 10n, 5n)).toEqual([]);
  });
});

// A fake node that answers like the live contracts, with switches to break each read.
const TIMELOCK = "0x4F656b09c4D3c859Dd2BB9919f384681e9ccb3f5" as Address;
const PROPOSER = "0xa21499ea134b8752c0376062B9b5cf1b48665c91" as Address;
const GUARDIAN = "0x31744293C35b42a3089dCbB4B171836397aA033A" as Address;
function node(broken: string[] = [], opts: { logsFail?: boolean; blockFails?: boolean } = {}) {
  const log = (e: string) => (e === "AdapterSet" ? [ADAPTER_SET] : WATCHER_SET);
  const answer: Record<string, unknown> = {
    ADMIN_EXPIRY: BigInt(EXPIRY), ADMIN: TIMELOCK, guardian: GUARDIAN, armingPaused: false, adapterAllowed: true,
    DELAY: 0n, PROPOSER, watcherSince: BigInt(SINCE), watcherUntil: BigInt(UNTIL),
  };
  const client = {
    getBlock: async () => { if (opts.blockFails) throw new Error("rpc"); return { number: 107_871_602n, timestamp: 1_793_997_960n }; },
    readContract: async (a: { address: string; functionName: string }) => {
      // ADMIN is read on both the router and the AlarmBook, so a break can name the contract too.
      if (broken.includes(a.functionName) || broken.includes(`${a.functionName}@${a.address === BOOK ? "book" : "router"}`)) throw new Error("revert");
      return a.functionName === "ADMIN" && a.address === BOOK ? TIMELOCK : answer[a.functionName];
    },
    getLogs: async (a: { event: { name: string } }) => { if (opts.logsFail) throw new Error("rpc"); return log(a.event.name); },
  };
  return client as unknown as PublicClient;
}
const live: Chain = { ...CONFIG, deployBlock: 107_737_863 };
const clock = () => 1_793_997_900;

describe("loading the limits", () => {
  test("reads every fact for the live deployment", async () => {
    const l = await loadLimits(live, clock, node());
    expect(l.expiry).toEqual({ ok: true, value: EXPIRY });
    expect(l.guardian).toEqual({ ok: true, value: GUARDIAN });
    expect(l.armingPaused).toEqual({ ok: true, value: false });
    expect(l.admin).toEqual({ ok: true, value: TIMELOCK });
    expect(l.delay).toEqual({ ok: true, value: 0 });
    expect(l.proposer).toEqual({ ok: true, value: PROPOSER });
    expect(l.watcherAdmin).toEqual({ ok: true, value: TIMELOCK });
    expect(l.adapters).toEqual({ ok: true, value: [{ adapter: ADAPTER, allowed: true }] });
    expect(l.clockOffset).toEqual({ ok: true, value: 60 });
    expect(l.watchers).toEqual({ ok: true, value: [W1, W2, W3].map((watcher) => ({ watcher, since: SINCE, until: UNTIL })) });
  });
  test("the mapping has the last word over the events", async () => {
    const l = await loadLimits(live, clock, { ...node(), readContract: async (a: { functionName: string }) => (a.functionName === "adapterAllowed" ? false : (await node().readContract(a as never))) } as unknown as PublicClient);
    expect(l.adapters).toEqual({ ok: true, value: [{ adapter: ADAPTER, allowed: false }] });
  });
  test("one failed read marks only that fact as unread", async () => {
    const cases: [string, (l: Awaited<ReturnType<typeof loadLimits>>) => unknown[]][] = [
      ["ADMIN_EXPIRY", (l) => [l.expiry]],
      ["guardian", (l) => [l.guardian]],
      ["armingPaused", (l) => [l.armingPaused]],
      ["DELAY", (l) => [l.delay]],
      ["PROPOSER", (l) => [l.proposer]],
      ["watcherUntil", (l) => [l.watchers]],
      ["ADMIN@book", (l) => [l.watcherAdmin]],
    ];
    for (const [name, which] of cases) {
      const l = await loadLimits(live, clock, node([name]));
      expect(which(l)).toEqual([{ ok: false }]);
      // Everything else still came back.
      const others = Object.entries(l).filter(([k, v]) => k !== "chain" && (v as { ok?: boolean }).ok === false);
      expect(others.length).toBe(1);
    }
  });
  test("with the Timelock unreadable, its delay and proposer are unread and not made up", async () => {
    const l = await loadLimits(live, clock, node(["ADMIN@router"]));
    expect(l.admin).toEqual({ ok: false });
    expect(l.delay).toEqual({ ok: false });
    expect(l.proposer).toEqual({ ok: false });
    expect(l.expiry.ok).toBe(true);
  });
  test("when the history can't be read, both lists are unread and nothing else is", async () => {
    const l = await loadLimits(live, clock, node([], { logsFail: true }));
    expect(l.adapters).toEqual({ ok: false });
    expect(l.watchers).toEqual({ ok: false });
    expect(l.expiry.ok && l.guardian.ok && l.delay.ok).toBe(true);
  });
  test("with no block time the lists are unread and the device clock stands in", async () => {
    const l = await loadLimits(live, clock, node([], { blockFails: true }));
    expect(l.clockOffset).toEqual({ ok: false });
    expect(l.adapters).toEqual({ ok: false });
    expect(l.watchers).toEqual({ ok: false });
  });
  test("with no deploy block configured, the lists are unread: the history is never started from a guess", async () => {
    const l = await loadLimits({ ...live, deployBlock: null }, clock, node());
    expect(l.adapters).toEqual({ ok: false });
    expect(l.watchers).toEqual({ ok: false });
    expect(l.expiry.ok).toBe(true);
  });
  test("a network with no contracts reads nothing", async () => {
    const l = await loadLimits({ ...live, router: null }, clock, node());
    expect([l.expiry, l.guardian, l.adapters, l.watchers].every((f) => !f.ok)).toBe(true);
  });
});

describe("the live deployment's config", () => {
  test("Robinhood Chain's deploy block is the recorded one", () => {
    expect(CONFIG.deployBlock).toBe(107_737_863);
    const record = join(import.meta.dir, "../../deploy/out/4663/deployment.json");
    if (!existsSync(record)) return; // the deploy record is private, so a public checkout skips this
    expect(CONFIG.deployBlock).toBe((JSON.parse(readFileSync(record, "utf8")) as { startBlock: number }).startBlock);
  });
  test("source links point at the verified contract on the explorer and Sourcify", () => {
    expect(sourceLinks(CONFIG, ROUTER)).toEqual({
      explorerName: "Blockscout", explorer: `https://robinhoodchain.blockscout.com/address/${ROUTER}?tab=contract`, sourcify: `https://repo.sourcify.dev/4663/${ROUTER}`,
    });
    expect(sourceLinks({ ...CONFIG, chainId: 8453, explorer: "https://basescan.org" }, ROUTER).explorer).toBe(`https://basescan.org/address/${ROUTER}#code`);
  });
});

describe("every claim is tied to a line of code", () => {
  const root = join(import.meta.dir, "../..");
  const source = (file: string) => readFileSync(join(root, file), "utf8").split("\n");
  const refs: SourceRef[] = [...CANNOT.flatMap((c) => c.refs), ...Object.values(ADMIN_REFS), ...Object.values(WATCHER_REFS)];
  test("each linked line holds the text it is quoted for", () => {
    for (const r of refs) expect(source(r.repoFile)[r.line - 1]!).toContain(r.quote);
  });
  test("the contracts have no recipient, no upgrade path and no fee in their code", () => {
    const code = (file: string) => source(file).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const router = code("contracts/src/ExitRouter.sol");
    const exit = router.slice(router.indexOf("function exit("), router.indexOf("{", router.indexOf("function exit(")));
    expect(exit).not.toMatch(/address/);
    for (const f of ["ExitRouter", "AlarmBook", "Timelock"]) {
      expect(code(`contracts/src/${f}.sol`)).not.toMatch(/delegatecall|selfdestruct|\bupgrade|\bproxy\b/i);
    }
    expect(router).not.toMatch(/\bfees?\b|treasury|feeBps/i);
    // Pausing is declared, checked in arm and set by setArmingPaused, and nowhere else.
    expect([...router.matchAll(/armingPaused/g)].length).toBe(3);
    expect(router.slice(router.indexOf("function exit("), router.indexOf("function claimOwed"))).not.toContain("armingPaused");
  });
  test("the 2-day wait and the one-year term in the copy are the contract's constants", () => {
    const book = source("contracts/src/AlarmBook.sol").join("\n");
    expect(book).toContain("WATCHER_DELAY = 2 days");
    expect(book).toContain("MAX_WATCHER_TERM = 365 days");
    expect(LIMITS_COPY.watcherRule).toContain("2 days");
    expect(LIMITS_COPY.watcherRule).toContain("within a year");
  });
  test("the admin expiry and Timelock are as SECURITY.md says", () => {
    const sec = readFileSync(join(root, "SECURITY.md"), "utf8");
    expect(sec).toContain("`ADMIN_EXPIRY`");
    expect(sec).toContain("Never: the list stays with the Timelock");
  });
});

describe("copy", () => {
  const strings = (v: unknown): string[] =>
    typeof v === "string" ? [v] : typeof v === "function" ? strings((v as (...a: never[]) => unknown)(...([1, "Robinhood Chain", true] as never[]))) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
  const all = [...strings(LIMITS_COPY), ...strings(CANNOT), ...strings(FACT_NAMES), ...strings(LIMITS_COPY.tweet.days(2)), ...strings(LIMITS_COPY.adminHeading(false))];
  test("passes the banned-word check, and avoids the words this page should not use", () => {
    for (const s of all) {
      expect(findBanned(s)).toEqual([]);
      expect(s).not.toMatch(/\b(safe|safely|safety|protect(ed|s|ion)?|guarantee[ds]?)\b/i);
    }
    expect(all.length).toBeGreaterThan(20);
  });
});
