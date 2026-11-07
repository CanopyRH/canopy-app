import { zeroAddress, type Address, type Hex } from "viem";
import { Kind, keyOf, presetsFor, type Preset } from "./presets";
const zero = `0x${"00".repeat(32)}` as Hex;
export interface ReaderConfig {
  pool: Address;
  reader: Address;
  kind: "reserve" | "price";
  threshold: string;
  heartbeat: number;
  reviewUrl: string;
}
/** Only repository-reviewed deployments become choices. Reserve drops are always paired with the pool quorum. */
export function readerPresets(
  pool: Address,
  configs: ReaderConfig[],
): Preset[] {
  const quorum = presetsFor(pool).find((p) => p.detector.kind === Kind.QUORUM)!;
  const out: Preset[] = [];
  for (const c of configs.filter(
    (c) => c.pool.toLowerCase() === pool.toLowerCase(),
  )) {
    if (
      !/^0x[0-9a-f]{40}$/i.test(c.reader) ||
      c.reader.toLowerCase() === zeroAddress ||
      !/^https:\/\//.test(c.reviewUrl) ||
      !/^\d+$/.test(c.threshold) ||
      BigInt(c.threshold) < 1n ||
      BigInt(c.threshold) > 2n ** 255n - 1n ||
      !Number.isInteger(c.heartbeat) ||
      c.heartbeat < 1 ||
      c.heartbeat > 172800
    )
      throw new Error("Invalid reviewed reader configuration");
    const detector = {
      kind: Kind.PRICE_BELOW,
      target: c.reader,
      threshold: BigInt(c.threshold),
      window: c.heartbeat,
      a: zero,
      b: zero,
    };
    const signal: Preset = {
      name:
        c.kind === "reserve" ? "Pool reserve below floor" : "Price below floor",
      note: "Owner-reviewed reader and threshold.",
      detector,
      key: keyOf(detector),
    };
    if (c.kind === "price") out.push(signal);
    else {
      const both = {
        kind: Kind.BOTH,
        target: pool,
        threshold: 0n,
        window: 86400,
        a: signal.key,
        b: quorum.key,
      };
      out.push({
        name: "Pool reserve loss + confirmation",
        note: "A reserve loss and two approved watchers must agree.",
        detector: both,
        key: keyOf(both),
        requires: [signal, quorum],
      });
    }
  }
  return out;
}
export function orderedDetectors(presets: Preset[]) {
  const map = new Map<string, Preset["detector"]>();
  const add = (p: Preset) => {
    for (const r of p.requires ?? []) add(r);
    map.set(p.key, p.detector);
  };
  presets.forEach(add);
  return [...map.values()];
}
