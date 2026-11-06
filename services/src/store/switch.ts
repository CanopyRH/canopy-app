import type { Db } from "./db";

/**
 * The contract switch. Every service shares one database, and what the router and AlarmBook logs wrote there belongs to one
 * pair of contracts. When the addresses in the environment change (v1 to v2), that state is wrong for the new pair, so one
 * service clears it, rewinds the two log cursors to the new START_BLOCK and remembers the new addresses. The rest find the
 * addresses already stored and do nothing.
 *
 * The switch is an operator's decision, not a side effect of starting: a service whose addresses differ from the stored
 * ones refuses to start (SwitchRefused) unless CONTRACT_SWITCH names its router, which is how the operator says "this is
 * the deploy that moves the database". Once switched, a later start with the old addresses differs again and refuses, so a
 * stale process can never switch the database back. The log cursors are named for the contract they follow (`router@0x...`),
 * so a process on other addresses can't move the new ones; and every writer checks the stored addresses against its own
 * before it acts (`contractFence`).
 *
 * Cleared: what the contracts' logs and the keeper's exit work derived. Never touched: plans, plan_payments, the payments
 * cursor, vault_follows, feed_items, signals, risk_cards, vault_snaps, vault_admins, sent_alerts, counters, alert and ops
 * jobs, and anything else about Telegram chats.
 */
export interface Addresses { router: string; alarmBook: string; startBlock: bigint }

/** Thrown when the stored addresses are not the ones a service was started with, and the operator did not authorise the switch. */
export class SwitchRefused extends Error {}

const lc = (a: string) => a.toLowerCase();
/** The cursor name of the router log reader for one router. A reader on other addresses has a different name. */
export const routerCursor = (router: string) => `router@${lc(router)}`;
/** The cursor name of the AlarmBook log reader for one AlarmBook. */
export const alarmsCursor = (alarmBook: string) => `alarms@${lc(alarmBook)}`;
export interface SwitchResult { cleared: Record<string, number>; from: { router: string | null; alarmBook: string | null } }

/** Jobs that exist because of the contracts. Alert and ops jobs belong to chats and are kept. */
export const CONTRACT_JOB_KINDS = ["exit", "poke", "checkpoint", "claim"] as const;
/**
 * The readers that follow the contracts: `router`, `alarms` and their per-address names (`router@0x...`). The payments
 * reader follows the plan token and stays.
 */
export const CONTRACT_CURSORS = ["router", "alarms"] as const;

/** A list of fixed names as SQL. Only ever fed the constants above. */
const inList = (names: readonly string[]) => `(${names.map((n) => `'${n}'`).join(",")})`;
const JOBS = inList(CONTRACT_JOB_KINDS);
/** A condition on a column holding a reader's name. */
const named = (col: string) => `(${CONTRACT_CURSORS.map((n) => `${col}='${n}' OR ${col} LIKE '${n}@%'`).join(" OR ")})`;

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
  ["log_retries", `DELETE FROM log_retries WHERE ${named("source")}`],
  ["block_hashes", `DELETE FROM block_hashes WHERE ${named("source")}`],
  ["log_touches", `DELETE FROM log_touches WHERE ${named("source")}`],
  ["reorg_recheck", `DELETE FROM reorg_recheck WHERE ${named("source")}`],
];

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
  return (await q.query(`SELECT 1 FROM cursors WHERE ${named("name")} LIMIT 1`)).length > 0;
}

async function run(q: Db, a: Addresses, authorise?: string): Promise<SwitchResult | null> {
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
  if (!authorise || lc(authorise) !== router) {
    throw new SwitchRefused(
      `the database holds state for router ${meta.get("router") ?? "none"} and alarm book ${meta.get("alarm_book") ?? "none"}, not for this service's addresses. ` +
      `Refusing to start. To move the database to these addresses on purpose, set CONTRACT_SWITCH to this router's address for this deploy only.`,
    );
  }
  const cleared: Record<string, number> = {};
  for (const [name, sql] of CLEAR) cleared[name] = await count(q, sql);
  // The cursor is the next block to read. One block early costs one empty read and can't skip a log.
  const start = a.startBlock > 0n ? a.startBlock - 1n : 0n;
  await q.query(`DELETE FROM cursors WHERE ${named("name")}`);
  for (const c of [routerCursor(router), alarmsCursor(book)]) {
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
export async function switchContracts(db: Db, a: Addresses, authorise?: string): Promise<SwitchResult | null> {
  if (!db.transaction) return run(db, a, authorise); // a single-process stand-in
  return db.transaction(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    return run(q, a, authorise);
  });
}

/** Thrown by a fence when the database has moved to (or never had) the addresses the caller was started with. */
export class ContractMismatch extends Error {}

/**
 * A check every writer runs at the start of a pass: the stored addresses are the ones this process was started with.
 * One small read per call. A process that was started before a switch, or whose addresses were never stored, throws
 * instead of writing rows that belong to other contracts.
 */
export function contractFence(db: Db, a: Pick<Addresses, "router" | "alarmBook">): () => Promise<void> {
  const router = lc(a.router), book = lc(a.alarmBook);
  return async () => {
    const rows = await db.query<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key IN ('router','alarm_book')`);
    const meta = new Map(rows.map((r) => [r.key, r.value]));
    if (meta.get("router") !== router || meta.get("alarm_book") !== book) {
      throw new ContractMismatch(`the database belongs to router ${meta.get("router") ?? "none"} and alarm book ${meta.get("alarm_book") ?? "none"}, not to ${router} and ${book}`);
    }
  };
}

/** The one log line and the operator message for a switch. No URLs. */
export function switchText(r: SwitchResult): string {
  const counts = Object.entries(r.cleared).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "no rows";
  return `contract switch: router ${r.from.router ?? "none"} -> new, alarm book ${r.from.alarmBook ?? "none"} -> new. Cleared ${counts}. Plans, payments and follows kept; router and alarm cursors reset.`;
}
