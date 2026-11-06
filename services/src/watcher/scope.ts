import type { Address } from "viem";
import { isPreset } from "../api/presets";
import type { Repo } from "../store/repo";

/**
 * Whether a watcher alarm is worth a watcher's signature and the keeper's gas. Anyone can register one on any
 * contract, so only two kinds count: a listed vault's own preset, and a key that a position armed (a paid one, when the
 * keeper runs paid plans only). Everything else is left alone.
 */
export function quorumScope(r: Repo, listed: readonly string[], now: () => number, paidOnly: boolean) {
  return async (key: string, target: string | null): Promise<boolean> => {
    const t = target?.toLowerCase();
    if (t && listed.includes(t) && isPreset(t as Address, key)) return true;
    const live = await r.liveKeys(paidOnly ? now() : undefined);
    return live.some((k) => k.toLowerCase() === key.toLowerCase());
  };
}
