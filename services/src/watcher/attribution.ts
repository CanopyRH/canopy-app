import { z } from "zod";
import type { VaultNames } from "./watcher";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase());
/** Trusted operator input, never model output or a peer request. Scope expires and binds exact source bytes. */
export const ReportApprovals = z
  .strictObject({
    version: z.literal(1),
    reports: z
      .array(
        z.strictObject({
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          sourceUrl: z.url().max(2048),
          chainId: z
            .number()
            .int()
            .positive()
            .max(2 ** 32 - 1),
          targets: z.array(address).min(1).max(32),
          reviewedAt: z.number().int().nonnegative().safe(),
          expiresAt: z.number().int().nonnegative().safe(),
        }),
      )
      .max(1000),
  })
  .superRefine((x, c) => {
    const seen = new Set<string>();
    for (const r of x.reports) {
      if (r.expiresAt <= r.reviewedAt || r.expiresAt - r.reviewedAt > 86400)
        c.addIssue({
          code: "custom",
          message: "Report approval lasts at most one day",
        });
      const id = `${r.chainId}:${r.sha256}:${r.sourceUrl}`;
      if (seen.has(id))
        c.addIssue({ code: "custom", message: "Duplicate report approval" });
      seen.add(id);
      if (new URL(r.sourceUrl).protocol !== "https:")
        c.addIssue({
          code: "custom",
          message: "Report sources must use HTTPS",
        });
    }
  });
export type ReportApprovals = z.infer<typeof ReportApprovals>;
export interface ReportScope {
  chainId: number;
  hash: string;
  sourceUrl: string;
  now: number;
  approvals: ReportApprovals;
}
/** Neither brand words, asset symbols nor model-provided addresses grant attribution. */
export function attributedVaults<T extends VaultNames>(
  vaults: T[],
  label: string | undefined,
  scope?: ReportScope,
): T[] {
  if (label !== "EXPLOIT_CONFIRMED" || !scope) return [];
  const approved = scope.approvals.reports.find(
    (r) =>
      r.chainId === scope.chainId &&
      r.sha256 === scope.hash &&
      r.sourceUrl === scope.sourceUrl &&
      r.reviewedAt <= scope.now &&
      r.expiresAt > scope.now,
  );
  if (!approved) return [];
  const targets = new Set(approved.targets.map((t) => t.toLowerCase()));
  return vaults.filter((v) => v.target && targets.has(v.target.toLowerCase()));
}
