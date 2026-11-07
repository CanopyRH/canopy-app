import type { ResearchQuery } from "./index";
import { address, ObservatoryError } from "./core";
export function parseResearchQuery(
  feature: string,
  entries: [string, string][],
): ResearchQuery {
  const vaultFeatures = ["oracles", "controls", "concentration", "liquidity"];
  const allowed = vaultFeatures.includes(feature)
    ? feature === "liquidity"
      ? ["vault", "owner"]
      : ["vault"]
    : feature === "perps"
      ? ["owner", "account"]
      : [];
  const seen = new Set<string>(),
    q: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!allowed.includes(k) || seen.has(k) || !v || v.length > 128)
      throw new ObservatoryError(
        "bad_query",
        "Use only the documented parameters, once each.",
      );
    seen.add(k);
    q[k] = v;
  }
  if (vaultFeatures.includes(feature)) address(q.vault ?? "");
  if (q.owner) address(q.owner);
  if (feature === "perps" && Boolean(q.owner) !== Boolean(q.account))
    throw new ObservatoryError(
      "bad_query",
      "Owner and account are required together.",
    );
  if (
    q.account !== undefined &&
    (!/^(0|[1-9]\d{0,14})$/.test(q.account) || Number(q.account) > 2 ** 48 - 1)
  )
    throw new ObservatoryError("bad_query", "Invalid venue account index.");
  return q;
}
