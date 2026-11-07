import type { Address, Hex } from "viem";
import { isPreset, Kind, keyOf, type Detector, type Preset } from "./presets";

/**
 * Your own alarm levels. A "Vault loss" alarm is a SHARE_DROP detector, and the only thing a user may change about it is
 * how far the share price must fall under its high before it fires. The choice is a short list, never a free number:
 * AlarmBook takes any threshold, so a free number would let anyone make thousands of keys on a listed vault, and the
 * keeper treats a listed vault's own keys as always worth a checkpoint. Five levels per vault is a fixed, small set.
 *
 * A level is built exactly like the preset (same fields, same encoding), so its key is deterministic: the browser works
 * it out itself, and anyone can register the same detector. The 0.5% level IS the "Vault loss" preset.
 */
export const LEVELS_BPS = [50, 100, 200, 500, 1000] as const;
export type LevelBps = (typeof LEVELS_BPS)[number];
/** The level of the "Vault loss" preset. */
export const DEFAULT_LEVEL_BPS: LevelBps = 50;

const ZERO = `0x${"00".repeat(32)}` as Hex;

export const isLevelBps = (n: number): n is LevelBps => (LEVELS_BPS as readonly number[]).includes(n);

/** 50 -> "0.5%", 1000 -> "10%". */
export const levelLabel = (bps: LevelBps): string => `${bps / 100}%`;

/** The share-drop detector for one level. Throws for any number that is not on the list. */
export function levelDetector(vault: Address, bps: number): Detector {
  if (!isLevelBps(bps)) throw new RangeError(`${bps} is not an alarm level`);
  return { kind: Kind.SHARE_DROP, target: vault, threshold: BigInt(bps), window: 0, a: ZERO, b: ZERO };
}

export function levelPreset(vault: Address, bps: LevelBps): Preset {
  const detector = levelDetector(vault, bps);
  return {
    name: `Vault loss at ${levelLabel(bps)}`,
    note: `The share price fell ${levelLabel(bps)} below its high.`,
    detector,
    key: keyOf(detector),
  };
}

/** Every level, smallest first. */
export const levelPresets = (vault: Address): Preset[] => LEVELS_BPS.map((bps) => levelPreset(vault, bps));

const cache = new Map<string, Set<string>>();
/** The keys of one vault's levels, lowercase. Cached because the keeper asks for every live key of every listed vault. */
function keysOf(vault: Address): Set<string> {
  const id = vault.toLowerCase();
  let keys = cache.get(id);
  if (!keys) {
    if (cache.size > 1_000) cache.clear();
    keys = new Set(levelPresets(id as Address).map((p) => p.key.toLowerCase()));
    cache.set(id, keys);
  }
  return keys;
}

/** Whether a key is one of this vault's five level keys. A key with any other threshold is not. */
export const isLevelKey = (vault: Address, key: string): boolean => keysOf(vault).has(key.toLowerCase());

/** A vault's own key: one of its presets, directly or as a part, or one of its levels. */
export const isOwnKey = (vault: Address, key: string): boolean => isPreset(vault, key) || isLevelKey(vault, key);

/** Every alarm the app may arm on a vault: its presets, then the levels the presets don't already include. */
export function armablePresets(vault: Address, presets: Preset[]): Preset[] {
  const have = new Set(presets.map((p) => p.key));
  return [...presets, ...levelPresets(vault).filter((p) => !have.has(p.key))];
}

/** The detectors a vault's levels need registered. Each stands alone, so there is no ordering to respect. */
export const levelDetectors = (vault: Address): Detector[] => LEVELS_BPS.map((bps) => levelDetector(vault, bps));
