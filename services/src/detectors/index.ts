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
 * Measured from the window's median, not its peak, so capital parked across one reading can't fake a drain.
 */
export function drainVelocity(
  samples: { t: number; totalAssets: bigint }[],
  windowSec: number,
  maxDropBps: bigint,
  target: Hex,
): Signal | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1]!;
  const inWin = samples.filter((s) => last.t - s.t <= windowSec);
  const sorted = inWin.map((s) => s.totalAssets).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const usual = sorted[Math.floor(sorted.length / 2)]!;
  if (usual === 0n || last.totalAssets >= usual) return null;
  const drop = ((usual - last.totalAssets) * BPS) / usual;
  return drop > maxDropBps
    ? { kind: "DRAIN", target, severity: "soft", value: Number(drop), at: last.t, evidence: `usual=${usual} now=${last.totalAssets}` }
    : null;
}
