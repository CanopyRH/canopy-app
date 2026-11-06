import { decodeErrorResult, parseAbi } from "viem";
import { COPY } from "./copy/text";

/** The contract errors a person can run into while arming. Each has a plain sentence in COPY. */
export const contractErrorsAbi = parseAbi([
  "error AlarmNotClear(bytes32 key)",
  "error ArmingIsPaused()",
  "error NotSupported()",
  "error TooManyKeys()",
  "error SwapsNeedStableHarbour()",
  "error TooManySwaps()",
  "error DuplicateSwap(address token)",
  "error BadFeed()",
  "error BadRoute()",
  "error BadHarbour()",
  "error SlipTooHigh()",
]);

const BY_NAME: Record<string, string> = {
  AlarmNotClear: COPY.errAlarmNotClear,
  ArmingIsPaused: COPY.errArmingPaused,
  NotSupported: COPY.errNotSupported,
  TooManyKeys: COPY.errTooManyKeys,
  SwapsNeedStableHarbour: COPY.errSwapsNeedStable,
  TooManySwaps: COPY.errTooManySwaps,
  DuplicateSwap: COPY.errDuplicateSwap,
  BadFeed: COPY.errBadSwap,
  BadRoute: COPY.errBadSwap,
  BadHarbour: COPY.errBadSwap,
  SlipTooHigh: COPY.errBadSwap,
};

/** Hex strings anywhere in an error, because wallets put revert data in different places (data, error.data, cause.data...). */
function hexesIn(e: unknown, seen = new Set<unknown>(), depth = 0): string[] {
  if (depth > 6 || e === null || e === undefined || seen.has(e)) return [];
  if (typeof e === "string") return /^0x[0-9a-fA-F]{8,}$/.test(e) ? [e] : [];
  if (typeof e !== "object") return [];
  seen.add(e);
  // Own names, not just enumerable ones: viem hangs the wrapped error on a non-enumerable `cause`.
  const obj = e as Record<string, unknown>;
  return Object.getOwnPropertyNames(obj).flatMap((k) => hexesIn(obj[k], seen, depth + 1));
}

/** The plain sentence for a revert this app knows, from the revert data or from the error's name in a wallet's message. Null otherwise. */
export function revertText(e: unknown): string | null {
  for (const data of hexesIn(e)) {
    try {
      const name = decodeErrorResult({ abi: contractErrorsAbi, data: data as `0x${string}` }).errorName;
      if (BY_NAME[name]) return BY_NAME[name]!;
    } catch {
      // Not one of ours.
    }
  }
  const msg = (e as { message?: string } | null)?.message ?? "";
  for (const [name, text] of Object.entries(BY_NAME)) if (new RegExp(`\\b${name}\\b`).test(msg)) return text;
  return null;
}
