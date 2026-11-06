import { expect, test } from "bun:test";
import { findBanned } from "../../tools/banned-words";
import copy from "../src/copy/board.json";
import { ago, duration, intentUrl, tweetText, usd, type BoardData } from "../src/site/board";

const board = (o: { value?: number | null; positions?: number; fastest?: number | null } = {}): BoardData => ({
  generatedAt: 1_000,
  armed: { value: o.value === undefined ? 4_200_000 : o.value, positions: o.positions ?? 312, wallets: 200, unpriced: 0, topVaults: [] },
  exits: {
    last24h: { count: 0, value: 0 }, last7d: { count: 0, value: 0 }, allTime: { count: 0, value: 0 },
    secondsToExit: { fastest: o.fastest === undefined ? 6 : o.fastest, median: null, samples: 0 }, latest: [],
  },
});

test("the tweet reads like the example", () => {
  expect(tweetText(board())).toBe("$4.2M armed on Canopy across 312 positions. Fastest exit: 6s. canopyrh.com/board");
});

test("the tweet drops the fastest exit until there is one, and says position for one", () => {
  expect(tweetText(board({ fastest: null, value: 850, positions: 1 }))).toBe("$850 armed on Canopy across 1 position. canopyrh.com/board");
});

test("zero state tweets what Canopy does instead of zeros", () => {
  const t = tweetText(board({ value: 0, positions: 0, fastest: null }));
  expect(t).toBe("Canopy watches DeFi vaults on Robinhood Chain and exits to your wallet when an alarm fires. canopyrh.com/board");
  expect(t).not.toContain("$0");
  expect(tweetText(board({ value: null, positions: 4 }))).not.toContain("null");
});

test("the tweet stays within 280 characters and the intent link encodes it", () => {
  const t = tweetText(board({ value: 1_234_567_890, positions: 1_234_567, fastest: 7_322 }));
  expect(t).toBe("$1.2B armed on Canopy across 1,234,567 positions. Fastest exit: 2h 2m. canopyrh.com/board");
  expect(t.length).toBeLessThanOrEqual(280);
  const u = new URL(intentUrl(t));
  expect(u.origin + u.pathname).toBe("https://x.com/intent/post");
  expect(u.searchParams.get("text")).toBe(t);
});

test("dollar and time formats", () => {
  expect([0, 412, 999, 1_000, 4_250, 999_960, 1_000_000, 4_200_000, 12_500_000].map(usd)).toEqual(["$0", "$412", "$999", "$1K", "$4.3K", "$1M", "$1M", "$4.2M", "$12.5M"]);
  expect(usd(null)).toBe("—");
  expect([0, 6, 59, 60, 125, 3600, 3725].map(duration)).toEqual(["0s", "6s", "59s", "1m", "2m 5s", "1h", "1h 2m"]);
  expect(duration(null)).toBe("—");
  expect([ago(null, 100), ago(95, 100), ago(0, 300), ago(0, 7_200), ago(0, 200_000)]).toEqual(["—", "just now", "5 min ago", "2 h ago", "2 d ago"]);
});

test("board copy has no banned words", () => {
  expect(findBanned(JSON.stringify(copy))).toEqual([]);
});
