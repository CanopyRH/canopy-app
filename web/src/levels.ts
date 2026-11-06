import type { Address, Hex } from "viem";
import { armablePresets, levelDetectors, levelPreset, levelPresets, LEVELS_BPS, type LevelBps } from "../../services/src/api/levels";
import { keyOf, type Detector, type Preset } from "../../services/src/api/presets";
import { keyStatus, type AlarmIo, type AlarmStatus } from "./alarms";

/**
 * The alarm level picker's logic, kept apart from the screen so it can be tested without a chain. The keys come from
 * services/src/api/levels.ts and are worked out here from the vault address, never fetched from a server.
 */
export interface LevelView { bps: LevelBps; preset: Preset; status: AlarmStatus }

/**
 * Each level with whether it is safe to arm. A level is a bare SHARE_DROP key, so it follows the same rule as every other
 * alarm: one that is tripped now, fired in the last 24 hours or can't be read is not offered. Levels nobody registered
 * yet read as clear, because a key that doesn't exist can't be going off; arming registers it first.
 */
export async function levelViews(io: AlarmIo, vault: Address): Promise<LevelView[]> {
  return Promise.all(levelPresets(vault).map(async (preset, i) => ({ bps: LEVELS_BPS[i]!, preset, status: await keyStatus(io, preset.key) })));
}

/** The level a list of chosen keys holds, or null when it holds none. */
export function chosenLevel(vault: Address, picked: Hex[]): LevelBps | null {
  return LEVELS_BPS.find((bps) => picked.includes(levelPreset(vault, bps).key)) ?? null;
}

/**
 * The chosen keys with the loss level set to `bps` (or removed, for null). A vault holds one loss level at a time, so
 * the older one goes. Other alarms stay in place, and a position can still arm at most eight keys in all.
 */
export function withLevel(vault: Address, picked: Hex[], bps: LevelBps | null): Hex[] {
  const levelKeys = new Set<Hex>(levelPresets(vault).map((p) => p.key));
  const rest = picked.filter((k) => !levelKeys.has(k));
  return bps === null ? rest : [...rest, levelPreset(vault, bps).key];
}

/** The presets and the five loss levels, for the arming checks. The 0.5% level is the "Vault loss" preset, so it appears once. */
export const armableFor = armablePresets;

/** Every detector arming may need to register: the presets' own, then the levels', each once. */
export function registrationFor(vault: Address, presetDetectors: Detector[]): Detector[] {
  const seen = new Map<Hex, Detector>();
  for (const d of [...presetDetectors, ...levelDetectors(vault)]) if (!seen.has(keyOf(d))) seen.set(keyOf(d), d);
  return [...seen.values()];
}
