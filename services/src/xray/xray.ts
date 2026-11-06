import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { presetsFor } from "../api/presets";
import type { CardNumbers } from "../risk/card";
import type { Db } from "../store/db";
import { changeLines, GATE_LABEL, liquidText, XRAY, type GateFact, type GateState, type XrayFacts } from "../copy/xray";

export const CARD_W = 1200;
export const CARD_H = 675;

const ZERO = "0x0000000000000000000000000000000000000000";
const asset = (f: string) => join(import.meta.dir, "assets", f);

/** Vault names come from the chain, so they are cleaned before they reach a card: no markup, no addresses, no long strings. */
export function cleanName(raw: string): string {
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ").replace(/0x[0-9a-fA-F]{6,}/g, "").replace(/\s+/g, " ").trim();
  const chars = [...s];
  return chars.length > 50 ? `${chars.slice(0, 49).join("").trimEnd()}…` : s || "Unnamed vault";
}

/** Whole units with thousands separators, or two decimals under a thousand. Exact: it works on the raw integer. */
export function amountText(raw: string, decimals: number): string {
  const unit = 10n ** BigInt(Math.max(decimals, 0));
  const v = BigInt(raw);
  const whole = v / unit;
  if (whole >= 1000n || decimals === 0) return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = ((v % unit) * 100n) / unit;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

const gateState = (g: CardNumbers["gates"][number]): GateState => {
  if (g.address === null) return "unknown";
  if (g.address !== ZERO) return "on";
  // Giving up a setter freezes the gate as it stands, so a gate that is off and given up stays off for good.
  return g.abdicated === true ? "given up" : g.abdicated === false ? "open" : "unknown";
};

/** The numbers on a card: what the saved risk card read from the chain, plus what the DB knows about positions armed on the vault. */
export function factsFrom(card: CardNumbers, armed: { positions: number; presets: string[] }): XrayFacts {
  const idle = BigInt(card.idleAssets);
  const total = card.totalAssets === null ? null : BigInt(card.totalAssets);
  const tenths = total !== null && total > 0n ? Number(idle >= total ? 1000n : (idle * 1000n) / total) : null;
  const gates: GateFact[] = card.version === "v2" ? card.gates.map((g) => ({ label: GATE_LABEL[g.name] ?? g.name, state: gateState(g) })) : [];
  return {
    vault: card.vault.toLowerCase(),
    name: cleanName(card.name),
    asset: cleanName(card.assetSymbol).slice(0, 12),
    version: card.version,
    held: card.totalAssets === null ? null : amountText(card.totalAssets, card.assetDecimals),
    idle: amountText(card.idleAssets, card.assetDecimals),
    liquidTenths: tenths,
    idleZero: idle === 0n,
    curatorSet: card.curator !== null && card.curator !== ZERO,
    gates,
    penaltyZero: card.forceDeallocatePenaltyZero,
    armed: armed.positions,
    presets: armed.presets,
  };
}

/** Armed positions on one vault and the alarm presets they use. Counts only; no owner or wallet is read. */
export async function armedOn(db: Db, vault: Address): Promise<{ positions: number; presets: string[] }> {
  const target = vault.toLowerCase();
  const n = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM positions WHERE target=$1 AND active AND confirmed`, [target]);
  const keys = await db.query<{ key: string }>(
    `SELECT DISTINCT k.key FROM position_keys k JOIN positions p ON p.pos_id=k.pos_id WHERE p.target=$1 AND p.active AND p.confirmed`,
    [target],
  );
  const used = new Set(keys.map((k) => k.key.toLowerCase()));
  const names = presetsFor(vault, vault, { paused: true }).filter((p) => used.has(p.key.toLowerCase())).map((p) => p.name);
  return { positions: Number(n[0]?.n ?? 0), presets: names };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Breaks text into lines of at most `max` characters, at spaces. */
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && line.length + 1 + w.length > max) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

let logo: string | undefined;
const logoUri = () => (logo ??= `data:image/png;base64,${readFileSync(asset("canopy-logo.png")).toString("base64")}`);

const INK = "#242424";
const MUTED = "#6a6a6a";

/** The alarms line, cut to three lines of the card with the rest counted. */
function alarmLines(presets: string[]): string[] {
  for (let k = presets.length; k >= 1; k--) {
    const rows = wrap(`Alarms: ${presets.slice(0, k).join(", ")}${k < presets.length ? `, +${presets.length - k} more` : ""}`, 26);
    if (rows.length <= 3) return rows;
  }
  return [`Alarms: ${presets.length} in use`];
}

const text = (x: number, y: number, size: number, s: string, o: { weight?: number; fill?: string; anchor?: string; spacing?: number } = {}) =>
  `<text x="${x}" y="${y}" font-family="Geist" font-size="${size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? INK}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.spacing ? ` letter-spacing="${o.spacing}"` : ""}>${esc(s)}</text>`;

const lines = (x: number, y: number, size: number, rows: string[], o: { fill?: string; step?: number; max?: number } = {}) =>
  rows.map((r, i) => text(x, y + i * (o.step ?? size + 8), size, r, { fill: o.fill })).join("");

/** The 1200 by 675 card as SVG. Nothing on it is a wallet address. */
export function renderSvg(f: XrayFacts): string {
  const nameSize = f.name.length <= 22 ? 60 : f.name.length <= 30 ? 48 : f.name.length <= 36 ? 40 : 32;
  const cols = [
    { x: 80, w: 310 },
    { x: 410, w: 400 },
    { x: 830, w: 290 },
  ];
  const top = 262;
  const box = cols.map((c) => `<rect x="${c.x}" y="${top}" width="${c.w}" height="262" rx="22" fill="#f4f4f7" stroke="#e2e2e6"/>`).join("");
  const label = (i: number, s: string) => text(cols[i]!.x + 24, top + 44, 15, s, { fill: MUTED, weight: 600, spacing: 1.8 });

  const liquid =
    label(0, XRAY.liquidLabel) +
    text(cols[0]!.x + 24, top + 130, f.liquidTenths === null ? 54 : 78, liquidText(f), { weight: 600 }) +
    lines(cols[0]!.x + 24, top + 176, 21, [f.liquidTenths === null ? "Could not read the vault" : `${f.idle} ${f.asset} idle`, ...(f.held ? [`of ${f.held} ${f.asset} held`] : [])].flatMap((l) => wrap(l, 24)), { fill: MUTED, step: 28 });

  const change = label(1, XRAY.changeLabel) + lines(cols[1]!.x + 24, top + 86, 20, changeLines(f).flatMap((l) => wrap(l, 32)).slice(0, 7), { step: 26 });

  const armed =
    label(2, XRAY.armedLabel) +
    text(cols[2]!.x + 24, top + 130, 78, String(f.armed), { weight: 600 }) +
    text(cols[2]!.x + 24, top + 164, 21, f.armed === 1 ? "position armed" : "positions armed", { fill: MUTED }) +
    (f.presets.length > 0 ? lines(cols[2]!.x + 24, top + 200, 19, alarmLines(f.presets), { step: 25 }) : "");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
<rect width="${CARD_W}" height="${CARD_H}" fill="#e8e8ec"/>
<rect x="40" y="40" width="1120" height="595" rx="32" fill="#ffffff"/>
<circle cx="108" cy="98" r="28" fill="#ffffff" stroke="#e2e2e6"/>
<image href="${logoUri()}" x="84" y="74" width="48" height="48"/>
${text(150, 108, 30, "Canopy", { weight: 600 })}
<rect x="${1120 - 190}" y="76" width="190" height="40" rx="20" fill="${INK}"/>
${text(1120 - 95, 102, 15, XRAY.kicker, { fill: "#ffffff", weight: 600, anchor: "middle", spacing: 2 })}
${text(80, 196, nameSize, f.name, { weight: 600 })}
${text(80, 236, 22, `ERC-4626 vault on Robinhood Chain · ${f.asset}`, { fill: MUTED })}
${box}${liquid}${change}${armed}
<line x1="80" y1="556" x2="1120" y2="556" stroke="#e2e2e6"/>
${text(80, 596, 25, XRAY.pitch, { weight: 600 })}
${text(80, 620, 15, XRAY.footnote, { fill: MUTED })}
${text(1120, 600, 32, XRAY.site, { weight: 600, anchor: "end" })}
</svg>`;
}

let ready: Promise<void> | undefined;
let fonts: Uint8Array[] | undefined;

/** Rasterises a card with resvg's WebAssembly build, which needs no native library and runs the same anywhere Bun does. */
export async function renderPng(svg: string): Promise<Uint8Array> {
  ready ??= initWasm(Bun.file(Bun.resolveSync("@resvg/resvg-wasm/index_bg.wasm", import.meta.dir)).arrayBuffer()).catch((e) => {
    ready = undefined;
    throw e;
  });
  await ready;
  fonts ??= ["Geist-Regular.ttf", "Geist-SemiBold.ttf"].map((f) => new Uint8Array(readFileSync(asset(f))));
  const r = new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily: "Geist", loadSystemFonts: false }, fitTo: { mode: "width", value: CARD_W } });
  try {
    return r.render().asPng();
  } finally {
    r.free();
  }
}
