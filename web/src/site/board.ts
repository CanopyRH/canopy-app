/** What GET /board returns. Mirrors services/src/api/board.ts. */
export interface BoardData {
  generatedAt: number;
  armed: {
    value: number | null;
    positions: number;
    wallets: number;
    unpriced: number;
    topVaults: { vault: string; name: string; value: number | null; positions: number }[];
  };
  exits: {
    last24h: { count: number; value: number };
    last7d: { count: number; value: number };
    allTime: { count: number; value: number };
    secondsToExit: { fastest: number | null; median: number | null; samples: number };
    latest: { vault: string; alarm: string | null; secondsToExit: number | null; amount: number; at: number | null; tx: string; txUrl: string | null }[];
  };
}

/** The address printed in the tweet. */
export const BOARD_LINK = "canopyrh.com/board";
export const REFRESH_MS = 60_000;

/** Dollars in the short form people quote: $412, $4.2K, $4.2M, $1.3B. Null (unknown) is a dash. */
export function usd(n: number | null): string {
  if (n === null) return "—";
  const short = (v: number, unit: string) => `$${(Math.round(v * 10) / 10).toString().replace(/\.0$/, "")}${unit}`;
  if (n >= 999_950_000) return short(n / 1e9, "B");
  if (n >= 999_950) return short(n / 1e6, "M");
  if (n >= 1_000) return short(n / 1e3, "K");
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Whole seconds as 6s, 2m 5s or 1h 2m. Null is a dash. */
export function duration(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 60)}m`;
  const m = Math.floor((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)}h ${m}m` : `${Math.floor(s / 3600)}h`;
}

/**
 * The text of the Post on X button, from the live numbers:
 * "$4.2M armed on Canopy across 312 positions. Fastest exit: 6s. canopyrh.com/board".
 * With nothing armed it says what Canopy does instead of quoting zeros, and the fastest exit is left out until there is one.
 */
export function tweetText(b: BoardData): string {
  const { positions, value } = b.armed;
  const fastest = b.exits.secondsToExit.fastest;
  if (positions === 0 || value === null || value <= 0) {
    return `Canopy watches DeFi vaults on Robinhood Chain and exits to your wallet when an alarm fires.${fastest === null ? "" : ` Fastest exit: ${duration(fastest)}.`} ${BOARD_LINK}`;
  }
  const across = `${positions.toLocaleString("en-US")} ${positions === 1 ? "position" : "positions"}`;
  return `${usd(value)} armed on Canopy across ${across}.${fastest === null ? "" : ` Fastest exit: ${duration(fastest)}.`} ${BOARD_LINK}`;
}

export const intentUrl = (text: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

/** "5 minutes ago" style age of an exit, from its time and now (both in seconds). */
export function ago(at: number | null, now: number): string {
  if (at === null) return "—";
  const d = Math.max(0, now - at);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86_400)} d ago`;
}
