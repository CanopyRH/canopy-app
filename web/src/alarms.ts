import type { Hex } from "viem";
import type { Preset } from "../../services/src/api/presets";

/**
 * Whether an alarm is already going off. AlarmBook never resets a tripped detector: a share price that stays below
 * its high-water mark, or a curator that changed once, refires every 24 hours. And an alarm that fired at the same
 * second as the arming still counts for the new position. So an alarm that is tripped now, or fired in the last
 * 24 hours, must never be armed.
 */
export const REFIRE_SECONDS = 86_400n;

/** The three chain reads the decision needs, so it can be tested without a chain. */
export interface AlarmIo {
  /** AlarmBook.check(key): would a poke fire this key right now? */
  check: (key: Hex) => Promise<boolean>;
  /** The key's last firing time in seconds, from AlarmBook.state(key). Zero when it never fired. */
  firedAt: (key: Hex) => Promise<bigint>;
  /** The chain's own clock, not the browser's. */
  now: () => Promise<bigint>;
}

/** clear: safe to offer. going-off: tripped now or fired in the last 24 hours. unreadable: Canopy could not tell. */
export type AlarmStatus = "clear" | "going-off" | "unreadable";

export async function keyStatus(io: AlarmIo, key: Hex): Promise<AlarmStatus> {
  try {
    const [tripped, firedAt, now] = await Promise.all([io.check(key), io.firedAt(key), io.now()]);
    if (tripped) return "going-off";
    return firedAt !== 0n && now <= firedAt + REFIRE_SECONDS ? "going-off" : "clear";
  } catch {
    return "unreadable"; // Fails closed: an alarm that can't be read is not offered.
  }
}

/**
 * The chosen keys that AlarmBook.armable() turns down: unknown, tripped, unreadable, or fired in the last day. This is the
 * contract's own answer, and the router asks it again inside `arm`, so it backs up the app's checks above. Ask it only
 * once the keys are registered, because an unknown key is not armable. A failed read counts as not armable.
 */
export async function notArmable(armable: (key: Hex) => Promise<boolean>, keys: Hex[]): Promise<Hex[]> {
  const answers = await Promise.all(keys.map((k) => armable(k).catch(() => false)));
  return keys.filter((_, i) => !answers[i]);
}

/** Every key a preset arms: its own key and the parts it depends on. The worst status wins. */
export async function presetStatus(io: AlarmIo, preset: Preset): Promise<AlarmStatus> {
  const keys = [preset.key, ...(preset.requires ?? []).map((p) => p.key)];
  const all = await Promise.all(keys.map((k) => keyStatus(io, k)));
  return all.includes("going-off") ? "going-off" : all.includes("unreadable") ? "unreadable" : "clear";
}

/** The chosen presets that must not be armed, with the reason for each. */
export async function refusedPresets(io: AlarmIo, presets: Preset[], chosen: Hex[]): Promise<{ preset: Preset; status: AlarmStatus }[]> {
  const picked = presets.filter((p) => chosen.includes(p.key));
  const out = await Promise.all(picked.map(async (preset) => ({ preset, status: await presetStatus(io, preset) })));
  return out.filter((o) => o.status !== "clear");
}
