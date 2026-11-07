import { zeroAddress, type Address } from "viem";
import { lookThrough } from "../risk/lookthrough";
import { bounded, type Observation } from "./core";

const FEEDS = [
  "BASE_FEED_1",
  "BASE_FEED_2",
  "QUOTE_FEED_1",
  "QUOTE_FEED_2",
] as const;
/** Interface observations describe a price construction; they do not certify the implementation. */
export async function oracleLens(o: Observation, vault: Address) {
  const graph = await bounded(
    lookThrough(o.client, vault, o.blockNumber),
    16_000,
  );
  const addresses = [
    ...new Set(
      graph.nodes.flatMap((n) => n.markets.map((m) => m.oracle.toLowerCase())),
    ),
  ];
  const rows = [];
  for (const at of addresses.slice(0, 8)) {
    const a = at as Address;
    const [price, scale, baseVault, quoteVault, ...feeds] = await Promise.all([
      o.read<bigint>(a, "price"),
      o.read<bigint>(a, "SCALE_FACTOR"),
      o.read<Address>(a, "BASE_VAULT"),
      o.read<Address>(a, "QUOTE_VAULT"),
      ...FEEDS.map((name) => o.read<Address>(a, name)),
    ]);
    const feedRows = [];
    for (let i = 0; i < feeds.length; i++) {
      const feed = feeds[i] as Address | null;
      if (!feed || feed === zeroAddress) {
        feedRows.push({
          role: FEEDS[i],
          address: feed,
          state: feed === null ? "unknown" : "not-used",
        });
        continue;
      }
      const [round, decimals, description] = await Promise.all([
        o.read<readonly [bigint, bigint, bigint, bigint, bigint]>(
          feed,
          "latestRoundData",
        ),
        o.read<number>(feed, "decimals"),
        o.read<string>(feed, "description"),
      ]);
      const age =
        round && round[3] > 0n && round[3] <= o.timestamp
          ? o.timestamp - round[3]
          : null;
      feedRows.push({
        role: FEEDS[i],
        address: feed,
        description: description?.slice(0, 120) ?? null,
        decimals,
        answer: round?.[1] ?? null,
        updatedAt: round?.[3] ?? null,
        ageSeconds: age,
        state: !round
          ? "unknown"
          : round[1] <= 0n || age === null || round[4] < round[0]
            ? "invalid-round"
            : "round-readable",
        freshness: "heartbeat-not-reviewed",
      });
    }
    rows.push({
      address: a,
      price,
      scale,
      baseVault,
      quoteVault,
      feeds: feedRows,
      construction: feeds.every((f) => f !== null)
        ? "feed-getters-readable"
        : "unclassified",
      markets: graph.nodes.flatMap((n) =>
        n.markets.filter((m) => m.oracle.toLowerCase() === at).map((m) => m.id),
      ),
    });
  }
  return o.finish(
    "oracles",
    {
      vault,
      oracles: rows,
      discoveryUnknown: graph.nodes.flatMap((n) =>
        n.unknown.map((reason) => ({ address: n.address, reason })),
      ),
      truncated: graph.truncated || addresses.length > 8,
    },
    [
      "A readable interface does not prove code identity, freshness, asset correspondence or independence.",
      "Morpho prices are collateral-to-loan raw-unit ratios scaled by 1e36, not USD prices. A positive price is not a safety rating.",
      "Only eight discovered oracles and 160 additional reads are inspected. Unknowns remain unknown; no oracle is called fixed-price solely because feeds are absent.",
    ],
  );
}
