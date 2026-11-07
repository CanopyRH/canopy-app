import type { Address } from "viem";
import { lookThrough, type ExposureGraph } from "../risk/lookthrough";
import { bounded, fractionBps, type Observation } from "./core";

export function concentrationOf(graph: ExposureGraph, vault: Address) {
  const root = graph.nodes.find(
    (n) => n.address.toLowerCase() === vault.toLowerCase(),
  );
  const rows = root?.markets ?? [];
  const sum = rows.reduce((n, m) => n + BigInt(m.allocationAssets), 0n);
  const group = (field: "collateral" | "oracle" | "irm") => {
    const buckets = new Map<
      string,
      { allocation: bigint; markets: Set<string> }
    >();
    for (const m of rows) {
      const key = m[field].toLowerCase();
      const b = buckets.get(key) ?? {
        allocation: 0n,
        markets: new Set<string>(),
      };
      b.allocation += BigInt(m.allocationAssets);
      b.markets.add(m.id);
      buckets.set(key, b);
    }
    return [...buckets]
      .map(([address, b]) => ({
        address,
        allocation: b.allocation.toString(),
        shareOfKnownBps: fractionBps(b.allocation, sum),
        markets: [...b.markets],
      }))
      .sort((a, b) =>
        BigInt(a.allocation) > BigInt(b.allocation)
          ? -1
          : BigInt(a.allocation) < BigInt(b.allocation)
            ? 1
            : a.address.localeCompare(b.address),
      );
  };
  return {
    vault,
    asset: root?.asset ?? null,
    knownAllocation: sum.toString(),
    collateral: group("collateral"),
    oracle: group("oracle"),
    rateModel: group("irm"),
    observedMarketCount: rows.length,
    truncated: graph.truncated,
    unknown: root?.unknown ?? ["Root vault unavailable"],
    cycles: graph.edges.filter((e) => e.cycle),
  };
}
export async function concentration(o: Observation, vault: Address) {
  return o.finish(
    "concentration",
    concentrationOf(
      await bounded(lookThrough(o.client, vault, o.blockNumber), 16_000),
      vault,
    ),
    [
      "Shares use known root-vault allocations in one asset only. They exclude idle balances, undiscovered allocations and nested valuations.",
      "Shared addresses show dependencies, not statistical correlation, independence or a recommendation.",
    ],
  );
}
