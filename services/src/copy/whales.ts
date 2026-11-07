/** All whale-alert wording lives here so the banned-words gate can check it. */

/** The alert topic a chat can turn off with /whales off. */
export const WHALE_TOPIC = "whales";

export interface MoveView {
  dir: "in" | "out";
  vaultName: string;
  usdCents: bigint;
  pctBps: number;
  /** What sits idle in the vault, in cents. Null when it couldn't be read. */
  liquidCents: bigint | null;
  /** The whale's full address. It is shortened here, and nothing else ever shows it. */
  wallet: string;
  tx: string;
  txUrl?: string;
  /** Seconds. */
  at: number;
}

/** 123456789 cents as "$1.2M". Rounds, and moves up a unit rather than print "$1000K". */
export function usdShort(cents: bigint): string {
  const dollars = Number(cents) / 100;
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, letter] of units) {
    if (dollars < size) continue;
    // 999.96K rounds to 1000K, which is 1M: say it in the next unit up.
    const up = units.find(([s]) => s === size * 1000);
    const v = Math.round((dollars / size) * 10) / 10;
    if (v >= 1000 && up) return `$${Math.round((dollars / up[0]) * 10) / 10}${up[1]}`;
    return `$${Number.isInteger(v) ? v : v.toFixed(1)}${letter}`;
  }
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}

/** 410 basis points as "4.1%". */
export function pctText(bps: number): string {
  if (bps <= 0) return "0%";
  if (bps < 10) return "<0.1%";
  if (bps >= 9_995) return "100%";
  return `${(bps / 100).toFixed(1)}%`;
}

/** 0x12ab…89ef: the first and last bytes' worth, enough to recognise, never the whole address. */
export const shortWallet = (a: string) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : "unknown");

const verb = (dir: "in" | "out") => (dir === "out" ? "just left" : "just moved into");

/** The follower alert. Its first line is the whole story, so it reads well alone in a post. */
export function whaleAlert(m: MoveView): string {
  return [
    `🐋 ${usdShort(m.usdCents)} ${verb(m.dir)} ${m.vaultName} (${pctText(m.pctBps)} of the vault).`,
    m.liquidCents === null ? "Liquid now: unknown." : `Liquid now: ${usdShort(m.liquidCents)} sitting idle in the vault.`,
    `Wallet ${shortWallet(m.wallet)}. ${m.txUrl ? `Tx: ${m.txUrl}` : `Tx: ${m.tx}`}`,
    "Your alarms: arm one in the app, button below.",
  ].join("\n");
}

export const ago = (at: number, now: number) => {
  const s = Math.max(0, now - at);
  if (s < 90) return "just now";
  if (s < 5_400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3_600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

/** /whales: the latest moves, one line each. No links, so Telegram shows no preview. */
export function whalesList(rows: MoveView[], now: number, muted: boolean): string {
  const status = muted ? "Whale alerts are off in this chat. /whales on turns them back on." : "Whale alerts are on in this chat. /whales off mutes them.";
  if (rows.length === 0) return `🐋 No whale moves yet on the listed vaults.\n${status}`;
  const lines = rows.map((m) => `${m.dir === "out" ? "Out" : "In"} ${usdShort(m.usdCents)} ${m.dir === "out" ? "from" : "to"} ${m.vaultName} (${pctText(m.pctBps)}), ${shortWallet(m.wallet)}, ${ago(m.at, now)}`);
  return [`🐋 The last ${rows.length} whale ${rows.length === 1 ? "move" : "moves"} on listed vaults:`, ...lines, status].join("\n");
}

export const WHALES_MUTED = "Whale alerts are off in this chat. /whales on turns them back on.";
export const WHALES_UNMUTED = "Whale alerts are on. You'll hear when a big deposit or withdrawal hits a vault you follow.";
export const WHALES_USAGE = "Use /whales for the latest moves, /whales off to mute alerts, /whales on to get them again.";
