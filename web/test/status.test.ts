import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import copy from "../src/copy/status.json";
// @ts-expect-error plain JS module
import { ago, blocks, dayLabel, duration, eventTitle, levels, validStatus, verdict } from "../src/site/statusFormat.js";

const NOW = 1_000_000;
const good = () => ({
  generatedAt: NOW,
  keeper: { lastActedAt: NOW - 600, gas: "healthy", queueDepth: 0, oldestQueuedSec: 0 },
  indexer: { lagBlocks: 2, state: "ok" },
  watchers: { approved: 1, list: [{ address: "0x00000000000000000000000000000000000000a1", lastAttestedAt: null }] },
  alarmChecks: { lastCheckedAt: NOW - 30 },
  history: [],
  alarmFirings: { days: 7, total: 0, byDay: [], recent: [] },
});

describe("status page logic", () => {
  test("a healthy answer reads as normal", () => {
    expect(verdict(good(), NOW)).toBe("ok");
  });

  test("low gas or a slow queue is a warning, empty gas or a lagging indexer needs attention", () => {
    const low = good();
    low.keeper.gas = "low";
    expect(verdict(low, NOW)).toBe("warn");
    const slow = good();
    slow.keeper.queueDepth = 2;
    slow.keeper.oldestQueuedSec = 301;
    expect(verdict(slow, NOW)).toBe("warn");
    const fresh = good();
    fresh.keeper.queueDepth = 2;
    fresh.keeper.oldestQueuedSec = 20;
    expect(verdict(fresh, NOW)).toBe("ok");
    const empty = good();
    empty.keeper.gas = "empty";
    expect(verdict(empty, NOW)).toBe("bad");
    const behind = good();
    behind.indexer.state = "behind";
    behind.indexer.lagBlocks = 9000;
    expect(verdict(behind, NOW)).toBe("bad");
  });

  test("the worst part wins", () => {
    const s = good();
    s.keeper.gas = "low";
    s.indexer.state = "behind";
    expect(verdict(s, NOW)).toBe("bad");
  });

  test("stale alarm checks warn after 3 minutes and need attention after 10", () => {
    const s = good();
    s.alarmChecks.lastCheckedAt = NOW - 179;
    expect(levels(s, NOW).checks).toBe("ok");
    s.alarmChecks.lastCheckedAt = NOW - 180;
    expect(levels(s, NOW).checks).toBe("warn");
    s.alarmChecks.lastCheckedAt = NOW - 600;
    expect(verdict(s, NOW)).toBe("bad");
  });

  test("missing numbers are said to be unknown, never read as healthy", () => {
    const s = good();
    s.keeper.gas = "unknown";
    expect(verdict(s, NOW)).toBe("warn");
    s.indexer = { lagBlocks: null as never, state: "unknown" };
    s.alarmChecks.lastCheckedAt = null as never;
    expect(verdict(s, NOW)).toBe("unknown");
    expect(blocks(null)).toBeNull();
  });

  test("wording", () => {
    expect(ago(1000, null)).toBeNull();
    expect(ago(1000, 990)).toBe("just now");
    expect(ago(1000, 700)).toBe("5 min ago");
    expect(ago(100000, 100000 - 7200)).toBe("2 h ago");
    expect(ago(1_000_000, 1_000_000 - 3 * 86400)).toBe("3 days ago");
    expect(duration(45)).toBe("45 s");
    expect(duration(250)).toBe("4 min 10 s");
    expect(duration(3900)).toBe("1 h 5 min");
    expect(blocks(1)).toBe("1 block");
    expect(blocks(12345)).toBe("12,345 blocks");
    expect(dayLabel(0)).toBe("Today");
    expect(dayLabel(1)).toBe("Yesterday");
    expect(dayLabel(4)).toBe("4 days ago");
  });

  test("every event the indexer records has a plain name, and an unknown one shows as it is", () => {
    for (const e of ["AdapterSet", "FeedSet", "RouteSet", "GuardianSet", "ArmingPaused", "WatcherSet"]) expect(eventTitle(e)).toBe((copy.events as Record<string, string>)[e]);
    expect(eventTitle("SomethingNew")).toBe("SomethingNew");
  });

  test("a wrong-shaped answer is rejected so the page shows its error state", () => {
    expect(validStatus(good())).toBe(true);
    expect(validStatus(null)).toBe(false);
    expect(validStatus({})).toBe(false);
    expect(validStatus({ ...good(), history: null })).toBe(false);
    expect(validStatus({ ...good(), keeper: {} })).toBe(false);
  });

  test("the page file is wired in: a page and its html with the matching data-page", () => {
    const html = readFileSync(new URL("../public/status.html", import.meta.url), "utf8");
    expect(html).toContain('data-page="status"');
    expect(readFileSync(new URL("../src/site/pages/status.jsx", import.meta.url), "utf8")).toContain("export default function Status");
  });
});

describe("status page rendering", () => {
  test("the board shows each section, links history to the explorer, and never prints a full alarm key", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    // @ts-expect-error plain JS module
    const { Board } = await import("../src/site/pages/status.jsx");
    const s: any = good();
    s.keeper.gas = "low";
    s.keeper.queueDepth = 3;
    s.keeper.oldestQueuedSec = 90;
    s.indexer.state = "behind";
    s.indexer.lagBlocks = 12345;
    const key = `0x${"cd".repeat(32)}`;
    const url = `https://robinhoodchain.blockscout.com/tx/0x${"ab".repeat(32)}`;
    s.history = [{ event: "GuardianSet", contract: "ExitRouter", block: 777, tx: `0x${"ab".repeat(32)}`, at: NOW - 60, txUrl: url }];
    s.alarmFirings = { days: 7, total: 2, byDay: [{ daysAgo: 0, count: 2 }, { daysAgo: 1, count: 0 }], recent: [{ key, firedAt: NOW - 30, tx: null, txUrl: null }] };
    const html = renderToStaticMarkup(React.createElement(Board, { s }));
    for (const text of ["Keeper", "Indexer", "Watchers", "Alarm checks", "Low", "12,345 blocks", "Guardian changed", "block 777", "Alarm firings, last 7 days", "Today"]) expect(html).toContain(text);
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain(`>${key}<`);
  });
});
