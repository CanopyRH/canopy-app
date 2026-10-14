import { encodeAbiParameters, keccak256, toFunctionSelector, type Address, type Hex } from "viem";

/** Mirrors AlarmBook.Kind. */
export const Kind = { PRICE_BELOW: 0, SHARE_DROP: 1, PAUSED: 2, ADDRESS_CHANGE: 3, DRAIN: 4, QUORUM: 5, BOTH: 6 } as const;
const ZERO = `0x${"00".repeat(32)}` as Hex;

export interface Detector { kind: number; target: Address; threshold: bigint; window: number; a: Hex; b: Hex }
export interface Preset { name: string; note: string; detector: Detector; key: Hex; requires?: Preset[] }

export const keyOf = (d: Detector): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }],
    [d.kind, d.target, d.threshold, d.window, d.a, d.b],
  ));

const sel = (sig: string) => toFunctionSelector(`function ${sig}`).padEnd(66, "0") as Hex;
const make = (name: string, note: string, d: Omit<Detector, "a" | "b"> & Partial<Pick<Detector, "a" | "b">>): Preset => {
  const detector = { a: ZERO, b: ZERO, ...d };
  return { name, note, detector, key: keyOf(detector) };
};

/** Common options. The user chooses; nothing is armed by default. */
export function presetsFor(vault: Address, protocol: Address = vault): Preset[] {
  const drain = make("Vault drain", "Soft. Needs a watcher to confirm.", { kind: Kind.DRAIN, target: vault, threshold: 2500n, window: 3600 });
  const curator = make("Curator change", "Soft. Needs a watcher to confirm.", { kind: Kind.ADDRESS_CHANGE, target: vault, threshold: 0n, window: 0, a: sel("curator()") });
  const quorum = make("Exploit confirmed", "Two approved watchers sign it.", { kind: Kind.QUORUM, target: protocol, threshold: 2n, window: 0 });
  const both = (p: Preset): Preset => ({
    // 24 hours, the contract's minimum: a part can't refire sooner, so a shorter window could miss a real hack.
    ...make(`${p.name} + confirmation`, "Fires only with a watcher confirmation.", { kind: Kind.BOTH, target: vault, threshold: 0n, window: 86_400, a: p.key, b: quorum.key }),
    requires: [p, quorum],
  });
  return [
    make("Vault loss", "The share price fell 0.5% below its high.", { kind: Kind.SHARE_DROP, target: vault, threshold: 50n, window: 0 }),
    quorum,
    make("Paused", "The vault reports that it is paused.", { kind: Kind.PAUSED, target: vault, threshold: 0n, window: 0 }),
    both(drain),
    both(curator),
  ];
}

/** Whether a key belongs to a vault's own presets, directly or as a part of one. */
export const isPreset = (vault: Address, key: string) => registrationOrder(vault).some((d) => keyOf(d) === key);

/** Every detector a vault's presets need, with dependencies first. AlarmBook rejects BOTH until its parts exist. */
export function registrationOrder(vault: Address, protocol: Address = vault): Detector[] {
  const seen = new Map<Hex, Detector>();
  const add = (p: Preset) => {
    for (const r of p.requires ?? []) add(r);
    if (!seen.has(p.key)) seen.set(p.key, p.detector);
  };
  for (const p of presetsFor(vault, protocol)) add(p);
  return [...seen.values()];
}
