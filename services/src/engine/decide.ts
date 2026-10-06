import type { Signal } from "../detectors";

export interface Decision {
  fire: boolean;
  reason: string;
  signals: Signal[];
  path: "ALARM_KEY" | "ATTEST" | "NONE";
}

/** Fire on one HARD signal, or on one SOFT on-chain signal + one INDEPENDENT confirmation.
 *  LLM labels alone never fire. */
export function decide(signals: Signal[], minIndependent = 2): Decision {
  const hard = signals.filter((s) => s.severity === "hard");
  if (hard.length > 0) return { fire: true, reason: `hard:${hard[0]!.kind}`, signals: hard, path: "ALARM_KEY" };
  const soft = signals.filter((s) => s.severity === "soft");
  const classes = new Set(soft.map((s) => (s.kind.startsWith("FEED_") ? "feed" : "chain")));
  const onchainSoft = soft.some((s) => !s.kind.startsWith("FEED_"));
  if (onchainSoft && classes.size >= minIndependent) {
    return { fire: true, reason: "soft+confirmation", signals: soft, path: "ATTEST" };
  }
  return { fire: false, reason: "insufficient", signals, path: "NONE" };
}
