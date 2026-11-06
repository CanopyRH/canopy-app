import type { Classification } from "../engine/llmClassify";

export type Severity = "hard" | "soft";
export type Hex = `0x${string}`;

export interface Signal {
  kind: string;
  target: Hex;
  severity: Severity;
  value: number;
  at: number;
  evidence: string;
}

const BPS = 10_000n;

/**
 * TVL drain velocity. Soft: big honest withdrawals look the same.
 * Measured from the window's median, not its peak, so capital parked across one reading can't fake a drain. With a
 * `longBaseline` (the median of the day before the window), the lower of the two is the usual level, so capital parked
 * for most of the window and then withdrawn reads as a return to the usual level, not a drain.
 */
export function drainVelocity(
  samples: { t: number; totalAssets: bigint }[],
  windowSec: number,
  maxDropBps: bigint,
  target: Hex,
  longBaseline?: bigint | null,
): Signal | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1]!;
  const inWin = samples.filter((s) => last.t - s.t <= windowSec);
  const sorted = inWin.map((s) => s.totalAssets).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const usual = longBaseline != null && longBaseline < median ? longBaseline : median;
  if (usual === 0n || last.totalAssets >= usual) return null;
  const drop = ((usual - last.totalAssets) * BPS) / usual;
  return drop > maxDropBps
    ? { kind: "DRAIN", target, severity: "soft", value: Number(drop), at: last.t, evidence: `usual=${usual} now=${last.totalAssets}` }
    : null;
}

/** Share price below high-water mark (realised bad debt). Hard. Mirrors AlarmBook SHARE_DROP. */
export function shareDrop(hwm: bigint, px: bigint, maxDropBps: bigint, target: Hex, at: number): Signal | null {
  if (hwm === 0n) return null;
  return px * BPS < hwm * (BPS - maxDropBps)
    ? { kind: "SHARE_DROP", target, severity: "hard", value: Number(((hwm - px) * BPS) / hwm), at, evidence: `hwm=${hwm} px=${px}` }
    : null;
}

/** Governance or owner change from logs. Soft. */
export const GOV_EVENTS = ["OwnershipTransferred(address,address)", "SetCurator(address)", "Upgraded(address)"] as const;

export function governance(eventName: string, target: Hex, at: number, detail: string): Signal | null {
  return (GOV_EVENTS as readonly string[]).includes(eventName)
    ? { kind: "GOVERNANCE", target, severity: "soft", value: 1, at, evidence: detail }
    : null;
}

export interface Admins { owner: string | null; curator: string | null }

/** Compares a vault's owner and curator with the last reading. A first reading or a failed read signals nothing. */
export function adminChanges(prev: Admins | null, next: Admins, target: Hex, at: number): Signal[] {
  if (!prev) return [];
  const changed = (was: string | null, now: string | null) => was !== null && now !== null && was.toLowerCase() !== now.toLowerCase();
  const out: (Signal | null)[] = [];
  if (changed(prev.owner, next.owner)) out.push(governance("OwnershipTransferred(address,address)", target, at, `owner ${prev.owner} -> ${next.owner}`));
  if (changed(prev.curator, next.curator)) out.push(governance("SetCurator(address)", target, at, `curator ${prev.curator} -> ${next.curator}`));
  return out.filter((s) => s !== null);
}

/** Pause events / paused() == true. Hard (the protocol itself says stop). */
export function paused(isPaused: boolean, target: Hex, at: number): Signal | null {
  return isPaused ? { kind: "PAUSED", target, severity: "hard", value: 1, at, evidence: "paused()=true" } : null;
}

/** A labelled public report. Always soft: it can confirm an on-chain signal, never fire alone. */
export function feedSignal(c: Classification, target: Hex, at: number, sourceHash: string, minConfidence = 0.8): Signal | null {
  if (c.confidence < minConfidence) return null;
  if (c.label !== "EXPLOIT_CONFIRMED" && c.label !== "DEPEG_REPORT") return null;
  return { kind: `FEED_${c.label}`, target, severity: "soft", value: c.confidence, at, evidence: sourceHash };
}
