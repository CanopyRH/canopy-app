import type { Address, Hex } from "viem";
import { Kind, keyOf, registrationOrder } from "../api/presets";
import type { Repo } from "../store/repo";
/** Listed preset upkeep is independent of customers. Other keys retain the existing paid/live scope and gas cap. */
export async function maintenanceKeys(
  r: Pick<Repo, "liveKeysOfKind">,
  listed: readonly string[],
  kind: number,
  paidAfter?: number,
): Promise<Hex[]> {
  if (kind !== Kind.DRAIN && kind !== Kind.SHARE_DROP)
    throw new Error("Unsupported maintenance kind");
  const presets = listed.flatMap((v) =>
    registrationOrder(v as Address)
      .filter((d) => d.kind === kind)
      .map(keyOf),
  );
  return [
    ...new Set(
      [...presets, ...(await r.liveKeysOfKind(kind, paidAfter))].map((k) =>
        k.toLowerCase(),
      ),
    ),
  ] as Hex[];
}
