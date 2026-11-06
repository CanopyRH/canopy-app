/** All X-ray card wording lives here so the banned-words gate can check it. Facts only: no ratings, no advice, no promises. */

export const XRAY = {
  site: "canopyrh.com",
  siteUrl: "https://canopyrh.com",
  pitch: "X-ray your vault before it X-rays you.",
  kicker: "VAULT X-RAY",
  liquidLabel: "LIQUID NOW",
  changeLabel: "WHO CAN CHANGE WHAT",
  armedLabel: "ARMED WITH CANOPY",
  footnote: "Read from the chain. Facts, not advice.",
  unknown: "unknown",
};

/** Plain names for the three share and asset gates a v2 vault can have. */
export const GATE_LABEL: Record<string, string> = {
  sendSharesGate: "send shares",
  receiveSharesGate: "receive shares",
  receiveAssetsGate: "receive assets",
};

export type GateState = "on" | "open" | "given up" | "unknown";

export interface GateFact { label: string; state: GateState }

export interface XrayFacts {
  vault: string;
  name: string;
  asset: string;
  version: "v1" | "v2" | "other";
  /** Whole units, already formatted. Null when the chain read failed. */
  held: string | null;
  idle: string;
  /** Tenths of a percent, 0 to 1000. Null when the vault holds nothing or the read failed. */
  liquidTenths: number | null;
  /** True when the vault holds none of its asset idle. */
  idleZero: boolean;
  curatorSet: boolean;
  gates: GateFact[];
  penaltyZero: boolean | null;
  armed: number;
  presets: string[];
}

/** Under a tenth of a percent but not nothing reads "<0.1%", so a sliver never shows as zero. */
export const liquidText = (f: Pick<XrayFacts, "liquidTenths" | "idleZero">) =>
  f.liquidTenths === null ? XRAY.unknown : f.liquidTenths === 0 && !f.idleZero ? "<0.1%" : `${(f.liquidTenths / 10).toFixed(1)}%`;

/** The lines of the "who can change what" block, as short plain sentences. */
export function changeLines(f: XrayFacts): string[] {
  const lines = [f.curatorSet ? "Curator can change settings." : "No curator set."];
  if (f.version !== "v2") return [...lines, "Share gates are checked on v2 vaults only."];
  const n = (s: GateState) => f.gates.filter((g) => g.state === s).length;
  const total = f.gates.length;
  if (n("on") > 0) lines.push(`Gates on now: ${n("on")} of ${total}.`, "An exit may be blocked.");
  if (n("open") > 0) lines.push(`Gates curator can still set: ${n("open")}.`);
  if (n("given up") > 0) lines.push(`Gates given up for good: ${n("given up")}.`);
  if (n("unknown") > 0) lines.push(`Gates that could not be read: ${n("unknown")}.`);
  if (f.penaltyZero === true) lines.push("Forced exit penalty: zero.");
  if (f.penaltyZero === false) lines.push("Forced exit penalty: above zero.");
  return lines;
}

export function armedLines(f: XrayFacts): string[] {
  if (f.armed === 0) return ["No positions armed on this vault yet."];
  const n = `${f.armed} position${f.armed === 1 ? "" : "s"} armed`;
  return f.presets.length > 0 ? [n, `Alarms in use: ${f.presets.join(", ")}.`] : [n];
}

/** One sentence for link previews. */
export function summary(f: XrayFacts): string {
  const liquid = f.liquidTenths === null ? "Liquid now: unknown" : `${liquidText(f)} liquid now (${f.idle} ${f.asset})`;
  const gates = f.version === "v2" ? `, ${f.gates.filter((g) => g.state === "given up").length} of ${f.gates.length} gates given up` : "";
  return `${f.name}: ${liquid}${gates}, ${f.armed} armed with Canopy.`;
}

export const pageTitle = (f: XrayFacts) => `X-ray: ${f.name} | Canopy`;
