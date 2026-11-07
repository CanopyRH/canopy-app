export interface DrainReference {
  snapAt: bigint;
  snap: bigint;
  prevSnap: bigint;
}
/** Readiness of the contract's two-period reference, not a statement about vault safety. */
export function drainReadiness(
  s: DrainReference,
  window: number,
  now: bigint,
): "ready" | "warming-up" | "stale" | "unreadable" {
  if (
    !Number.isSafeInteger(window) ||
    window < 1200 ||
    s.snapAt < 0n ||
    s.snap < 0n ||
    s.prevSnap < 0n ||
    s.snapAt > now
  )
    return "unreadable";
  if (s.snap === 0n || s.prevSnap === 0n) return "warming-up";
  return now - s.snapAt > BigInt(window) ? "stale" : "ready";
}
