import { z } from "zod";
const units = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(78);
const id = z.string().min(1).max(120);
export const ClosePolicy = z.strictObject({
  venue: id,
  account: id,
  market: id,
  maxCloseBps: z.number().int().min(1).max(10000),
  maxSlippageBps: z.number().int().min(0).max(100),
  expiresAt: z.number().int().positive(),
  maxObservationAge: z.number().int().min(1).max(60),
});
export type ClosePolicy = z.infer<typeof ClosePolicy>;
export const PositionSnapshot = z.strictObject({
  venue: id,
  account: id,
  market: id,
  side: z.enum(["long", "short"]),
  size: units,
  mark: units,
  reference: units,
  observedAt: z.number().int().positive(),
  referenceAt: z.number().int().positive(),
  healthy: z.boolean(),
});
/** A dry-run order plan. A venue-specific verified connector must re-read and enforce it immediately before signing. */
export function planClose(
  policy: ClosePolicy,
  snapshot: z.infer<typeof PositionSnapshot>,
  request: {
    size: string;
    now: number;
    armedPolicyMatches: boolean;
    alarmLive: boolean;
    venuePermissionsVerified: boolean;
  },
) {
  ClosePolicy.parse(policy);
  PositionSnapshot.parse(snapshot);
  units.parse(request.size);
  if (!Number.isSafeInteger(request.now) || request.now >= policy.expiresAt)
    throw new Error("Expired policy");
  if (!request.armedPolicyMatches || !request.alarmLive)
    throw new Error("No matching armed live alarm");
  if (!request.venuePermissionsVerified)
    throw new Error("Venue permissions have not been independently verified");
  if (!snapshot.healthy)
    throw new Error(
      "Venue unavailable; alert and retry without assuming an exit",
    );
  for (const field of ["venue", "account", "market"] as const)
    if (policy[field] !== snapshot[field])
      throw new Error("Position does not match policy");
  for (const at of [snapshot.observedAt, snapshot.referenceAt])
    if (at > request.now || request.now - at > policy.maxObservationAge)
      throw new Error("Stale or future observation");
  const size = BigInt(request.size),
    position = BigInt(snapshot.size),
    reference = BigInt(snapshot.reference),
    mark = BigInt(snapshot.mark);
  if (
    size > position ||
    size > (position * BigInt(policy.maxCloseBps)) / 10000n
  )
    throw new Error("Order exceeds the owner close cap");
  if (
    (mark > reference ? mark - reference : reference - mark) * 10000n >
    reference * BigInt(policy.maxSlippageBps)
  )
    throw new Error("Mark/reference gap exceeds policy");
  const side = snapshot.side === "long" ? "sell" : "buy";
  const limit =
    side === "sell"
      ? (reference * BigInt(10000 - policy.maxSlippageBps) + 9999n) / 10000n
      : (reference * BigInt(10000 + policy.maxSlippageBps)) / 10000n;
  if (limit === 0n) throw new Error("Invalid price after rounding");
  return {
    kind: "unsigned-close-plan" as const,
    venue: policy.venue,
    account: policy.account,
    market: policy.market,
    side,
    size: size.toString(),
    reduceOnly: true as const,
    timeInForce: "IOC" as const,
    limitPrice: limit.toString(),
    recipient: null,
    observedAt: snapshot.observedAt,
  };
}
