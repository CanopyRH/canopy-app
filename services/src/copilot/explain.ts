import type { ExposureGraph } from "../risk/lookthrough";
/** Deterministic explanation of sourced facts. No LLM score and no inferred oracle safety. */
export function explainExposure(graph: ExposureGraph) {
  const root = graph.nodes[0];
  if (!root) return ["No position facts could be read."];
  const lines = [
    `Underlying position facts at block ${graph.blockNumber}.`,
    `Owner role: ${root.roles.owner ?? "unknown"}. Curator: ${root.roles.curator ?? "unknown"}. Guardian: ${root.roles.guardian ?? "unknown"}.`,
  ];
  if (root.markets.length)
    for (const m of root.markets)
      lines.push(
        `Market ${m.id}: ${m.allocationAssets} raw loan-asset units allocated (${m.accounting === "expected-adapter-assets" ? "adapter expected assets" : "stored accounting"}); utilization ${m.utilizationBps === null ? "unknown" : `${Number(m.utilizationBps) / 100}%`}. Collateral ${m.collateral}. Oracle ${m.oracle}; its pricing method has not been verified.`,
      );
  if (root.adapters.length)
    lines.push(
      `Vault adapters: ${root.adapters.join(", ")}. Cross-asset allocation weights remain unknown.`,
    );
  const nested = graph.edges.filter(
    (e) =>
      e.kind === "collateral" &&
      graph.nodes.some(
        (n) => n.address.toLowerCase() === e.to.toLowerCase() && n.asset,
      ),
  );
  if (nested.length)
    lines.push(
      `Nested vault collateral found on ${nested.length} path(s). This adds dependencies; it is not a risk rating.`,
    );
  lines.push(...root.unknown);
  if (graph.truncated)
    lines.push("The depth or read limit was reached. This view is incomplete.");
  lines.push(
    "Oracle types, external ratings, unlisted privileged roles and economic correlations remain unknown. A successful read is not a safety judgment.",
  );
  return lines;
}
