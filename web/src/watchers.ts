/** What GET /watchers returns (services/src/watcher/roster.ts). Parsed defensively: the page shows only what it can check. */
export interface WatcherAttestation {
  key: string;
  evidence: string;
  attestedAt: number;
  deadline: number;
  firedAt: number | null;
  matched: boolean;
}

export interface WatcherRow {
  address: string;
  source: "chain" | "config";
  /** "pending": approved, but a new watcher only counts 2 days after approval. "listed": only in the service's settings, dates unknown. */
  status: "active" | "pending" | "listed";
  approvedAt: number | null;
  /** When the approval starts to count and when it ends (every approval ends within 365 days). Null for "listed". */
  activeFrom: number | null;
  expiresAt: number | null;
  lastAttestedAt: number | null;
  attestations30d: number;
  matched30d: number;
  recent: WatcherAttestation[];
}

export interface WatchersReport {
  windowDays: number;
  generatedAt: number;
  watchers: WatcherRow[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const numOrNull = (v: unknown) => (v === null ? null : isNum(v) ? v : undefined);
const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/** Returns the report, or null when the response is not shaped like one. A row that is malformed is dropped, not shown half-true. */
export function parseReport(raw: unknown): WatchersReport | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || !isNum(r.windowDays) || !isNum(r.generatedAt) || !Array.isArray(r.watchers)) return null;
  const watchers: WatcherRow[] = [];
  for (const w of r.watchers as Record<string, unknown>[]) {
    const approvedAt = numOrNull(w?.approvedAt);
    const lastAttestedAt = numOrNull(w?.lastAttestedAt);
    const activeFrom = numOrNull(w?.activeFrom);
    const expiresAt = numOrNull(w?.expiresAt);
    if (!w || !isAddress(w.address) || (w.source !== "chain" && w.source !== "config")) continue;
    if (w.status !== "active" && w.status !== "pending" && w.status !== "listed") continue;
    if (activeFrom === undefined || expiresAt === undefined || approvedAt === undefined || lastAttestedAt === undefined || !isNum(w.attestations30d) || !isNum(w.matched30d) || !Array.isArray(w.recent)) continue;
    const recent: WatcherAttestation[] = [];
    for (const a of w.recent as Record<string, unknown>[]) {
      const firedAt = numOrNull(a?.firedAt);
      if (!a || !isHash(a.key) || !isHash(a.evidence) || !isNum(a.attestedAt) || !isNum(a.deadline) || firedAt === undefined || typeof a.matched !== "boolean") continue;
      recent.push({ key: a.key, evidence: a.evidence, attestedAt: a.attestedAt, deadline: a.deadline, firedAt, matched: a.matched });
    }
    watchers.push({ address: w.address, source: w.source, status: w.status, approvedAt, activeFrom, expiresAt, lastAttestedAt, attestations30d: w.attestations30d, matched30d: w.matched30d, recent });
  }
  return { windowDays: r.windowDays, generatedAt: r.generatedAt, watchers };
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "5 minutes ago", "3 days ago", or "never". `now` and `at` are Unix seconds. */
export function ago(now: number, at: number | null): string {
  if (at === null) return "never";
  const s = Math.max(0, now - at);
  if (s < 60) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86_400) return unit(Math.floor(s / 3600), "hour");
  return unit(Math.floor(s / 86_400), "day");
}

/** A UTC date and time such as "2026-11-06 14:03 UTC", so the page reads the same in every time zone. */
export const utc = (at: number) => `${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** One plain sentence for a watcher's count: how many signatures, and how many matched an alarm that fired. */
export function countsLine(w: Pick<WatcherRow, "attestations30d" | "matched30d">, days: number): string {
  if (w.attestations30d === 0) return `No signatures in the last ${days} days`;
  const n = w.attestations30d;
  const m = w.matched30d;
  return `${n} ${n === 1 ? "signature" : "signatures"}, ${m} of them matched an alarm that fired`;
}

/** The API's address to read from. Empty means the page's own origin, which is how a local test deployment is served. */
export const watchersUrl = (apiUrl: string) => `${apiUrl.replace(/\/+$/, "")}/watchers`;
