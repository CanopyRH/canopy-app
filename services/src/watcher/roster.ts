import { isAddress, type Address, type Hex } from "viem";
import type { AdminEvent } from "../indexer/admin";
import type { Db } from "../store/db";

const DAY = 86_400;
/** The page counts attestations over this many days. The log keeps one day more, so the edge of the window is never half-empty. */
export const WINDOW_DAYS = 30;
/**
 * Watchers sign a deadline of floor(now / 600) * 600 + 1200, so a signature was made up to 1,200 seconds before its
 * deadline, and AlarmBook refuses it after the deadline. An alarm for the same key that fired in that span is the one this
 * signature could have helped fire.
 */
export const SIGN_SPAN = 1_200;
/** Most attestations listed per watcher. The counts above them are always complete. */
export const RECENT_PER_WATCHER = 25;
const MAX_WATCHERS = 50;

/** True when an alarm for the same key fired inside the span the signature covered. `l` is the log row. */
const FIRED = `EXISTS (SELECT 1 FROM alarms a WHERE a.key=l.key AND a.fired_at BETWEEN l.deadline-${SIGN_SPAN} AND l.deadline)`;

/**
 * Keeps an AlarmBook WatcherSet event, so the page can say who is approved and since when. Replays change nothing.
 * Returns whether the event was one. `recorded_at` is when the indexer read the log, which on a live chain is within
 * seconds of the change.
 */
export async function recordWatcherSet(db: Db, e: AdminEvent, now: number): Promise<boolean> {
  if (e.contract !== "AlarmBook" || e.event !== "WatcherSet") return false;
  const arg = (name: string) => e.args.find(([n]) => n === name)?.[1];
  const watcher = arg("watcher");
  if (!watcher || !isAddress(watcher, { strict: false })) return false;
  await db.query(
    `INSERT INTO watcher_events (tx, log_index, watcher, allowed, block, recorded_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [e.tx ?? "", e.logIndex ?? 0, watcher.toLowerCase(), arg("allowed") === "true", (e.block ?? 0n).toString(), now],
  );
  return true;
}

/**
 * Keeps one accepted attestation with the time it arrived, for 31 days. The core `attestations` table is pruned after 8
 * days and has no time, which is not enough to say when a watcher last signed or how often in a month.
 */
export async function logAttestation(db: Db, a: { key: Hex; evidence: Hex; deadline: bigint; signer: Address }, now: number): Promise<void> {
  await db.query(
    `INSERT INTO watcher_attest_log (signer, key, evidence_hash, deadline, seen_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [a.signer.toLowerCase(), a.key.toLowerCase(), a.evidence.toLowerCase(), a.deadline.toString(), now],
  );
  await db.query(`DELETE FROM watcher_attest_log WHERE seen_at<$1`, [now - (WINDOW_DAYS + 1) * DAY]);
}

export interface RosterAttestation {
  key: string;
  evidence: string;
  /** When this operator's API took the signature in. */
  attestedAt: number;
  deadline: number;
  /** When an alarm for the same key fired inside the signature's span, or null. */
  firedAt: number | null;
  matched: boolean;
}

export interface RosterWatcher {
  address: string;
  /** "chain" when a WatcherSet event was recorded for it, "config" when it is only in this operator's WATCHERS setting. */
  source: "chain" | "config";
  /** When the indexer read the event that approved it. Null for a "config" watcher. */
  approvedAt: number | null;
  lastAttestedAt: number | null;
  attestations30d: number;
  matched30d: number;
  recent: RosterAttestation[];
}

export interface Roster {
  windowDays: number;
  generatedAt: number;
  watchers: RosterWatcher[];
}

/**
 * Who is approved and what each has signed. Approved means the latest WatcherSet event for the address says allowed. An
 * address with no recorded event counts if this operator lists it in WATCHERS, which covers a list set before the indexer
 * began recording these events. A removal event wins over the setting.
 */
export async function rosterReport(db: Db, configured: readonly string[], now: number): Promise<Roster> {
  const since = now - WINDOW_DAYS * DAY;
  const events = await db.query<{ watcher: string; allowed: boolean; recorded_at: string }>(
    `SELECT DISTINCT ON (watcher) watcher, allowed, recorded_at FROM watcher_events ORDER BY watcher, block DESC, log_index DESC`,
  );
  const approved = new Map<string, { source: "chain" | "config"; approvedAt: number | null }>();
  const removed = new Set<string>();
  for (const ev of events) {
    if (ev.allowed) approved.set(ev.watcher, { source: "chain", approvedAt: Number(ev.recorded_at) });
    else removed.add(ev.watcher);
  }
  for (const w of configured.map((x) => x.toLowerCase())) if (!approved.has(w) && !removed.has(w)) approved.set(w, { source: "config", approvedAt: null });

  const stats = await db.query<{ signer: string; last: string; n: string; matched: string }>(
    `SELECT l.signer, MAX(l.seen_at)::text AS last,
            COUNT(*) FILTER (WHERE l.seen_at>=$1)::text AS n,
            COUNT(*) FILTER (WHERE l.seen_at>=$1 AND ${FIRED})::text AS matched
     FROM watcher_attest_log l GROUP BY l.signer`,
    [since],
  );
  const byStat = new Map(stats.map((s) => [s.signer, s]));

  const watchers: RosterWatcher[] = [];
  for (const [address, info] of [...approved].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, MAX_WATCHERS)) {
    const s = byStat.get(address);
    const rows = s
      ? await db.query<{ key: string; evidence_hash: string; deadline: string; seen_at: string; fired_at: string | null }>(
          `SELECT l.key, l.evidence_hash, l.deadline::text AS deadline, l.seen_at::text AS seen_at,
                  (SELECT MIN(a.fired_at)::text FROM alarms a WHERE a.key=l.key AND a.fired_at BETWEEN l.deadline-${SIGN_SPAN} AND l.deadline) AS fired_at
           FROM watcher_attest_log l WHERE l.signer=$1 AND l.seen_at>=$2 ORDER BY l.seen_at DESC, l.key LIMIT ${RECENT_PER_WATCHER}`,
          [address, since],
        )
      : [];
    watchers.push({
      address,
      source: info.source,
      approvedAt: info.approvedAt,
      lastAttestedAt: s ? Number(s.last) : null,
      attestations30d: Number(s?.n ?? 0),
      matched30d: Number(s?.matched ?? 0),
      recent: rows.map((x) => ({
        key: x.key,
        evidence: x.evidence_hash,
        attestedAt: Number(x.seen_at),
        deadline: Number(x.deadline),
        firedAt: x.fired_at === null ? null : Number(x.fired_at),
        matched: x.fired_at !== null,
      })),
    });
  }
  return { windowDays: WINDOW_DAYS, generatedAt: now, watchers };
}
