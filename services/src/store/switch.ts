import type { Db } from "./db";

/**
 * The contract switch. Every service shares one database, and what the router and AlarmBook logs wrote there belongs to one
 * pair of contracts. When the addresses in the environment change (v1 to v2), that state is wrong for the new pair, so the
 * first service to start clears it, rewinds the two log cursors to the new START_BLOCK and remembers the new addresses.
 * The rest find the addresses already stored and do nothing.
 *
 * Cleared: what the contracts' logs and the keeper's exit work derived. Never touched: plans, plan_payments, the payments
 * cursor, vault_follows, feed_items, signals, risk_cards, vault_snaps, vault_admins, sent_alerts, counters, alert and ops
 * jobs, and anything else about Telegram chats.
 */
export interface Addresses { router: string; alarmBook: string; startBlock: bigint }
export interface SwitchResult { cleared: Record<string, number>; from: { router: string | null; alarmBook: string | null } }

/** Jobs that exist because of the contracts. Alert and ops jobs belong to chats and are kept. */
export const CONTRACT_JOB_KINDS = ["exit", "poke", "checkpoint", "claim"] as const;
/** The log cursors that follow the contracts. The payments cursor follows the plan token and stays. */
export const CONTRACT_CURSORS = ["router", "alarms"] as const;

/** A list of fixed names as SQL. Only ever fed the constants above. */
const inList = (names: readonly string[]) => `(${names.map((n) => `'${n}'`).join(",")})`;
const JOBS = inList(CONTRACT_JOB_KINDS), CURSORS = inList(CONTRACT_CURSORS);

const LOCK = 7226680; // not the migration lock (7226679)

/** The tables and the counts a switch would clear, as SQL that returns one count each. */
const CLEAR: [name: string, sql: string][] = [
  ["position_keys", "DELETE FROM position_keys"],
  ["positions", "DELETE FROM positions"],
  ["owner_epochs", "DELETE FROM owner_epochs"],
  ["exit_payouts", "DELETE FROM exit_payouts"],
  ["exits", "DELETE FROM exits"],
  ["owed", "DELETE FROM owed"],
  ["owed_logs", "DELETE FROM owed_logs"],
  ["alarms", "DELETE FROM alarms"],
  ["attestations", "DELETE FROM attestations"],
  ["detectors", "DELETE FROM detectors"],
  ["jobs", `DELETE FROM jobs WHERE kind IN ${JOBS}`],
  ["log_retries", `DELETE FROM log_retries WHERE source IN ${CURSORS}`],
  ["block_hashes", `DELETE FROM block_hashes WHERE source IN ${CURSORS}`],
  ["log_touches", `DELETE FROM log_touches WHERE source IN ${CURSORS}`],
  ["reorg_recheck", `DELETE FROM reorg_recheck WHERE source IN ${CURSORS}`],
];

const lc = (a: string) => a.toLowerCase();

async function count(q: Db, sql: string): Promise<number> {
  const rows = await q.query<{ n: number | string }>(`WITH d AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM d`);
  return Number(rows[0]?.n ?? 0);
}

/** Whether any row exists that the contracts or the keeper's exit work wrote. */
async function hasContractState(q: Db): Promise<boolean> {
  for (const t of ["positions", "detectors", "alarms", "exits", "owner_epochs"]) {
    if ((await q.query(`SELECT 1 FROM ${t} LIMIT 1`)).length > 0) return true;
  }
  if ((await q.query(`SELECT 1 FROM jobs WHERE kind IN ${JOBS} LIMIT 1`)).length > 0) return true;
  return (await q.query(`SELECT 1 FROM cursors WHERE name IN ${CURSORS} LIMIT 1`)).length > 0;
}

async function run(q: Db, a: Addresses): Promise<SwitchResult | null> {
  const meta = new Map((await q.query<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key IN ('router','alarm_book')`)).map((r) => [r.key, r.value]));
  const router = lc(a.router), book = lc(a.alarmBook);
  if (meta.get("router") === router && meta.get("alarm_book") === book) return null;
  const store = async () => {
    for (const [k, v] of [["router", router], ["alarm_book", book]] as const) {
      await q.query(`INSERT INTO meta (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [k, v]);
    }
  };
  // Nothing stored and nothing derived: a new database. Remember the addresses and clear nothing.
  if (!meta.has("router") && !meta.has("alarm_book") && !(await hasContractState(q))) {
    await store();
    return null;
  }
  const cleared: Record<string, number> = {};
  for (const [name, sql] of CLEAR) cleared[name] = await count(q, sql);
  // The cursor is the next block to read. One block early costs one empty read and can't skip a log.
  const start = a.startBlock > 0n ? a.startBlock - 1n : 0n;
  for (const c of CONTRACT_CURSORS) {
    await q.query(`INSERT INTO cursors (name, block) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET block=$2`, [c, start.toString()]);
  }
  await store();
  return { cleared, from: { router: meta.get("router") ?? null, alarmBook: meta.get("alarm_book") ?? null } };
}

/**
 * Switches the database to a new pair of contracts if it isn't on them already. Safe to call from every service at once:
 * one transaction under an advisory lock, so one does the work and the others wait, then find nothing to do. Returns what
 * it cleared, or null when there was nothing to do.
 */
export async function switchContracts(db: Db, a: Addresses): Promise<SwitchResult | null> {
  if (!db.transaction) return run(db, a); // a single-process stand-in
  return db.transaction(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    return run(q, a);
  });
}

/** The one log line and the operator message for a switch. No URLs. */
export function switchText(r: SwitchResult): string {
  const counts = Object.entries(r.cleared).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "no rows";
  return `contract switch: router ${r.from.router ?? "none"} -> new, alarm book ${r.from.alarmBook ?? "none"} -> new. Cleared ${counts}. Plans, payments and follows kept; router and alarm cursors reset.`;
}
