import { z } from "zod";
const Report = z.object({
  version: z.literal(1),
  feature: z.enum([
    "oracles",
    "controls",
    "concentration",
    "liquidity",
    "perps",
    "funding",
  ]),
  chainId: z.number().int().positive(),
  observedAt: z.record(z.string(), z.unknown()),
  data: z.record(z.string(), z.unknown()),
  limitations: z.array(z.string()).max(32),
});
/** Imported exports are data, never executable rules or URLs. Bounds also apply to CLI callers. */
export function compareReports(before: unknown, after: unknown) {
  if (
    JSON.stringify(before).length > 2_000_000 ||
    JSON.stringify(after).length > 2_000_000
  )
    throw new Error("Report exceeds 2 MB");
  const a = Report.parse(before),
    b = Report.parse(after);
  if (a.feature !== b.feature || a.chainId !== b.chainId)
    throw new Error("Choose reports of the same feature and chain");
  for (const k of ["vault", "owner", "account"])
    if (
      String(a.data[k] ?? "").toLowerCase() !==
      String(b.data[k] ?? "").toLowerCase()
    )
      throw new Error("Report subjects do not match");
  if (
    typeof a.observedAt.block === "string" &&
    typeof b.observedAt.block === "string"
  ) {
    if (
      !/^\d{1,30}$/.test(a.observedAt.block) ||
      !/^\d{1,30}$/.test(b.observedAt.block) ||
      BigInt(b.observedAt.block) < BigInt(a.observedAt.block)
    )
      throw new Error("Reports are out of order");
    if (
      a.observedAt.block === b.observedAt.block &&
      a.observedAt.hash !== b.observedAt.hash
    )
      throw new Error(
        "Conflicting block hashes; reread after the reorganization",
      );
  } else if (
    typeof a.observedAt.receivedAt !== "number" ||
    typeof b.observedAt.receivedAt !== "number" ||
    b.observedAt.receivedAt < a.observedAt.receivedAt
  )
    throw new Error("Reports are out of order");
  const ownerOf = (r: typeof a) => {
    const p = r.data.position;
    return p && typeof p === "object" && "owner" in p
      ? String(p.owner).toLowerCase()
      : "";
  };
  if (ownerOf(a) !== ownerOf(b))
    throw new Error("Report position owners do not match");
  const changes: { path: string; before: unknown; after: unknown }[] = [];
  let visited = 0,
    truncated = false;
  const walk = (x: unknown, y: unknown, path: string, depth: number) => {
    if (++visited > 20_000 || depth > 12 || changes.length >= 200) {
      truncated = true;
      return;
    }
    if (x === y) return;
    if (
      x !== null &&
      y !== null &&
      typeof x === "object" &&
      typeof y === "object" &&
      Array.isArray(x) === Array.isArray(y)
    ) {
      for (const key of [
        ...new Set([...Object.keys(x), ...Object.keys(y)]),
      ].sort())
        walk(
          (x as any)[key],
          (y as any)[key],
          `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          depth + 1,
        );
    } else changes.push({ path, before: x ?? null, after: y ?? null });
  };
  walk(a.data, b.data, "/data", 0);
  return {
    version: 1,
    feature: "changes",
    chainId: a.chainId,
    observedAt: b.observedAt,
    data: { comparedFeature: a.feature, changes, truncated },
    limitations: [
      "Exports are user-supplied and are not authenticated by this comparison. Differences show changed fields, not proven attacks or economic risk.",
      "At most 200 changes are returned. Array positions are compared as exported. Monitoring in the browser runs only while its tab remains open.",
    ],
  };
}
