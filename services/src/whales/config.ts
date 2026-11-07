import { z } from "zod";

/** What counts as a whale move, and how loud the alerts may be. Read from the environment; every field has a default. */
const Whale = z.object({
  WHALE_WATCH: z.stringbool().default(true), // false stops the reader and the alerts; the API and /whales still show what was recorded
  WHALE_MIN_USD: z.coerce.number().min(0).default(250_000), // a move needs at least this many dollars...
  WHALE_MIN_PCT: z.coerce.number().min(0).max(100).default(2), // ...and at least this percent of the vault's assets. The larger of the two is the bar.
  WHALE_MAX_PER_HOUR: z.coerce.number().int().min(0).default(6), // follower alerts per vault per hour; moves past it are recorded, not sent. 0 sends none.
  WHALE_START_BLOCK: z.coerce.bigint().min(0n).optional(), // where a first run starts reading; off means the chain head, so old moves aren't announced
});

export interface WhaleConfig { watch: boolean; minUsd: number; minPct: number; maxPerHour: number; startBlock?: bigint }

/** A blank value means "not set", as in the main environment. */
export function whaleConfig(raw: Record<string, string | undefined>): WhaleConfig {
  const e = Whale.parse(Object.fromEntries(Object.entries(raw).filter(([k, v]) => k.startsWith("WHALE_") && v !== "")));
  return { watch: e.WHALE_WATCH, minUsd: e.WHALE_MIN_USD, minPct: e.WHALE_MIN_PCT, maxPerHour: e.WHALE_MAX_PER_HOUR, startBlock: e.WHALE_START_BLOCK };
}

/** A move older than this is recorded but not announced, so catching up after downtime doesn't flood followers. */
export const MAX_ALERT_AGE_SEC = 3_600;
/** Assets worth one dollar each. Any other asset is skipped, because there is no price to compare to the bar. */
export const DOLLAR_ASSETS = ["USDG", "USDC"];
