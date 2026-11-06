import type { Address } from "viem";
import { isPreset } from "../api/presets";
import type { Repo } from "../store/repo";

/**
 * Whether a watcher alarm is worth a watcher's signature and the keeper's gas. Anyone can register one on any
 * contract, so only two kinds count: a listed vault's own preset, and a key that a position armed (a paid one, when the
 * keeper runs paid plans only). Everything else is left alone.
 */
export function quorumScope(r: Repo, listed: readonly string[], now: () => number, paidOnly: boolean) {
  return async (key: string, target: string | null): Promise<boolean> => (await quorumScopeNow(r, listed, now, paidOnly))(key, target);
}

/**
 * The same rule with the live keys read once, for a loop that checks every watcher alarm in one pass. Reading them per
 * alarm cost one full query per registered alarm, and registering one is open to anyone.
 */
export async function quorumScopeNow(r: Repo, listed: readonly string[], now: () => number, paidOnly: boolean) {
  const live = new Set((await r.liveKeys(paidOnly ? now() : undefined)).map((k) => k.toLowerCase()));
  return (key: string, target: string | null): boolean => {
    const t = target?.toLowerCase();
    if (t && listed.includes(t) && isPreset(t as Address, key)) return true;
    return live.has(key.toLowerCase());
  };
}
