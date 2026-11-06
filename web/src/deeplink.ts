import { getAddress, isAddress, type Address } from "viem";

/**
 * Links from the Telegram bot arrive as the URL fragment: `#exit=<vault>`, `#disarm-all` or `#risk=<vault>`. They name a
 * vault or an action and nothing else, so they carry no wallet and no amount. Anything that starts like one of these but is
 * not exactly one is refused, and a bare wallet address is still the landing page's hand-over.
 */
export type DeepLink =
  | { kind: "exit"; vault: Address }
  | { kind: "risk"; vault: Address }
  | { kind: "disarm-all" }
  | { kind: "wallet"; value: string }
  | { kind: "refused" };

const VAULT = /^0x[0-9a-fA-F]{40}$/;
const RESERVED = /^(exit|risk|disarm)/i;

export function parseDeepLink(hash: string): DeepLink | null {
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return { kind: "refused" };
  }
  if (raw === "disarm-all") return { kind: "disarm-all" };
  const m = /^(exit|risk)=(.*)$/.exec(raw);
  if (m) {
    const vault = m[2]!;
    return VAULT.test(vault) && isAddress(vault, { strict: false }) ? { kind: m[1] as "exit" | "risk", vault: getAddress(vault.toLowerCase()) } : { kind: "refused" };
  }
  if (RESERVED.test(raw)) return { kind: "refused" };
  return { kind: "wallet", value: raw };
}

export interface LinkRow { vault: { address: Address; name: string }; state: { armed: boolean } | null }
export interface LinkContext {
  /** Whether the app has contracts to send to. */
  live: boolean;
  /** The listed vaults. A link to any other vault is refused. */
  vaults: readonly { address: Address; name: string }[];
  /** The connected wallet's positions, or null while they are being read. */
  rows: readonly LinkRow[] | null;
  /** False when some vault could not be read, so a missing position proves nothing. */
  complete: boolean;
  /** Whether a wallet is connected and is the one whose positions `rows` holds. */
  connected: boolean;
}

export type LinkStep =
  | { step: "none" }
  | { step: "refused" }
  | { step: "not-live" }
  | { step: "unknown-vault" }
  | { step: "connect"; vault?: string }
  | { step: "reading" }
  | { step: "unreadable" }
  | { step: "no-position"; vault: string }
  | { step: "not-armed"; vault: string }
  | { step: "exit"; vault: Address; name: string }
  | { step: "risk"; vault: Address; name: string }
  | { step: "disarm" };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What the app should show for a link, given what it knows so far. Nothing here sends anything: the person still confirms and signs. */
export function linkStep(link: DeepLink | null, c: LinkContext): LinkStep {
  if (!link || link.kind === "wallet") return { step: "none" };
  if (link.kind === "refused") return { step: "refused" };
  const v = link.kind === "disarm-all" ? null : c.vaults.find((x) => same(x.address, link.vault));
  if (link.kind === "risk") return v ? { step: "risk", vault: v.address, name: v.name } : { step: "unknown-vault" };
  if (!c.live) return { step: "not-live" };
  if (link.kind === "disarm-all") return c.connected ? { step: "disarm" } : { step: "connect" };
  if (!v) return { step: "unknown-vault" };
  if (!c.connected) return { step: "connect", vault: v.name };
  if (!c.rows) return { step: "reading" };
  const row = c.rows.find((r) => same(r.vault.address, v.address));
  if (!row) return c.complete ? { step: "no-position", vault: v.name } : { step: "unreadable" };
  if (!row.state?.armed) return { step: "not-armed", vault: v.name };
  return { step: "exit", vault: v.address, name: v.name };
}
