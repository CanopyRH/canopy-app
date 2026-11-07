import { z } from "zod";
import type { Address, Hex } from "viem";
const label = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .transform((s) => s.toLowerCase());
export const Profiles = z
  .array(
    z.strictObject({
      signer: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .transform((s) => s.toLowerCase()),
      operator: label,
      modelFamily: label,
      primarySource: label,
    }),
  )
  .min(2)
  .max(32)
  .superRefine((rows, ctx) => {
    if (new Set(rows.map((r) => r.signer)).size !== rows.length)
      ctx.addIssue({
        code: "custom",
        message: "A signer must have exactly one profile",
      });
  });
export type Profiles = z.infer<typeof Profiles>;
/** Local policy, not an AlarmBook consensus rule. Labels must be reviewed by the operator, not supplied by peers. */
export function diverseQuorum(
  rows: { signer: Address; sig: Hex }[],
  k: number,
  profiles: Profiles,
) {
  if (!Number.isInteger(k) || k < 2 || k > 32) return null;
  const known = new Map(profiles.map((p) => [p.signer.toLowerCase(), p]));
  const unique = new Map(rows.map((r) => [r.signer.toLowerCase(), r]));
  const candidates = [...unique.values()]
    .filter((r) => known.has(r.signer.toLowerCase()))
    .sort((a, b) =>
      a.signer.toLowerCase().localeCompare(b.signer.toLowerCase()),
    )
    .slice(0, 32);
  let work = 0;
  function search(start: number, chosen: typeof rows): typeof rows | null {
    if (++work > 100_000) return null;
    if (chosen.length === k) return chosen;
    for (let i = start; i <= candidates.length - (k - chosen.length); i++) {
      const next = candidates[i]!,
        p = known.get(next.signer.toLowerCase())!;
      if (
        chosen.some((r) => {
          const q = known.get(r.signer.toLowerCase())!;
          return (
            p.operator === q.operator ||
            p.modelFamily === q.modelFamily ||
            p.primarySource === q.primarySource
          );
        })
      )
        continue;
      const result = search(i + 1, [...chosen, next]);
      if (result) return result;
    }
    return null;
  }
  const result = search(0, []);
  return result
    ? { signers: result.map((r) => r.signer), sigs: result.map((r) => r.sig) }
    : null;
}
