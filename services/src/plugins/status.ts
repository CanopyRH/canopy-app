import { Env } from "../env";
import { chainParts, txUrl } from "../chain/addresses";
import type { ApiDeps } from "../api/server";
import type { Plugin } from "../plugins";

/**
 * GET /status: the public "Is Canopy working right now?" numbers. It reuses what /health computes, but copies out only a
 * short list of safe fields, so a new /health field never becomes public by accident. /health itself is untouched, and
 * this route sits under the same public read limit as every other plug-in route.
 */

const DAY = 86_400;
const WEEK = 7 * DAY;
const CACHE_SEC = 5;
const HISTORY = 20;
const RECENT_FIRINGS = 10;

export type GasState = "healthy" | "low" | "empty" | "unknown";
export type IndexerState = "ok" | "behind" | "unknown";

/** Healthy at or above the ops threshold, low below it, empty when about a tenth of it or less is left. */
export function gasState(wei: bigint | null, minWei: bigint): GasState {
  if (wei === null) return "unknown";
  if (wei <= minWei / 10n) return "empty";
  return wei < minWei ? "low" : "healthy";
}

const asInt = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const asWei = (v: unknown): bigint | null => {
  try {
    return typeof v === "string" && /^\d{1,40}$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
};

/** Reads the admin alert that the indexer queued (see indexer/admin.ts): which event, on which contract, in which block. */
export function parseAdminAlert(dedupe: string, text: string) {
  const id = /^ops:admin:(0x[0-9a-fA-F]{64}):\d+$/.exec(dedupe);
  const m = /admin event (\w+) on (\w+)(?: in block (\d+))?\./.exec(text);
  if (!id || !m) return null;
  return { event: m[1]!, contract: m[2]!, block: m[3] ? Number(m[3]) : null, tx: id[1]!.toLowerCase() };
}

const minGas = () => {
  const raw = process.env.KEEPER_MIN_GAS_WEI;
  const parsed = Env.shape.KEEPER_MIN_GAS_WEI.safeParse(raw === "" ? undefined : raw);
  return parsed.success ? parsed.data : Env.shape.KEEPER_MIN_GAS_WEI.parse(undefined);
};

export async function buildStatus(d: ApiDeps) {
  const now = d.now();
  // The same numbers /health serves. If the chain does not answer, the page says "unknown" rather than guessing.
  let h: Record<string, unknown> = {};
  try {
    h = ((await d.health?.()) ?? {}) as Record<string, unknown>;
  } catch {
    h = {};
  }
  const counters = (h.counters ?? {}) as Record<string, unknown>;
  const lagBlocks = asInt(h.lagBlocks);
  const maxLag = Number(chainParts(d.chainId).maxLagBlocks);

  const [acted] = await d.db.query<{ at: string | null }>(`SELECT MAX(created_at)::text AS at FROM jobs WHERE kind='exit' AND done`);
  const [queue] = await d.db.query<{ n: string; oldest: string | null }>(`SELECT COUNT(*)::text AS n, MIN(created_at)::text AS oldest FROM jobs WHERE kind='exit' AND NOT done`);
  const [checked] = await d.db.query<{ at: string | null }>(`SELECT MAX(t)::text AS at FROM vault_snaps`);

  // A watcher signs inside a 10-minute window and the deadline is that window's start plus 20 minutes, so the start is the signing time to within 10 minutes.
  const signed = await d.db.query<{ signer: string; deadline: string }>(`SELECT lower(signer) AS signer, MAX(deadline)::text AS deadline FROM attestations GROUP BY lower(signer)`);
  const lastSigned = new Map(signed.map((s) => [s.signer, Number(s.deadline) - 1200]));
  const watchers = [...new Set(d.watchers.map((w) => w.toLowerCase()))].map((address) => {
    const at = lastSigned.get(address);
    return { address, lastAttestedAt: at === undefined ? null : Math.min(at, now) };
  });

  const admin = await d.db.query<{ dedupe: string; payload: { text?: unknown }; created_at: string }>(
    `SELECT dedupe, payload, created_at::text AS created_at FROM jobs WHERE kind='ops' AND dedupe LIKE 'ops:admin:%' ORDER BY created_at DESC, id DESC LIMIT $1`, [HISTORY],
  );
  const history = admin.flatMap((j) => {
    const e = typeof j.payload?.text === "string" ? parseAdminAlert(j.dedupe, j.payload.text) : null;
    return e ? [{ ...e, at: Number(j.created_at), txUrl: txUrl(d.chainId, e.tx) ?? null }] : [];
  });

  const since = now - WEEK;
  const [total] = await d.db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM alarms WHERE fired_at>$1`, [since]);
  const perDay = await d.db.query<{ ago: string; n: string }>(`SELECT (($1::bigint - fired_at)/86400)::text AS ago, COUNT(*)::text AS n FROM alarms WHERE fired_at>$2 GROUP BY 1`, [now, since]);
  const byDay = Array.from({ length: 7 }, (_, i) => ({ daysAgo: i, count: Number(perDay.find((p) => Number(p.ago) === i)?.n ?? 0) }));
  const recent = await d.db.query<{ key: string; fired_at: string; tx: string | null }>(`SELECT key, fired_at::text AS fired_at, tx FROM alarms WHERE fired_at>$1 ORDER BY fired_at DESC, key DESC LIMIT $2`, [since, RECENT_FIRINGS]);

  const gas = asWei(counters.keeper_gas_wei);
  return {
    generatedAt: now,
    keeper: {
      lastActedAt: acted?.at ? Number(acted.at) : null,
      gas: gasState(gas, minGas()),
      queueDepth: Number(queue?.n ?? 0),
      oldestQueuedSec: queue?.oldest ? Math.max(0, now - Number(queue.oldest)) : 0,
    },
    indexer: { lagBlocks, state: (lagBlocks === null ? "unknown" : lagBlocks <= maxLag ? "ok" : "behind") as IndexerState },
    watchers: { approved: watchers.length, list: watchers },
    alarmChecks: { lastCheckedAt: checked?.at ? Number(checked.at) : null },
    history,
    alarmFirings: {
      days: 7,
      total: Number(total?.n ?? 0),
      byDay,
      recent: recent.map((a) => ({ key: a.key, firedAt: Number(a.fired_at), tx: a.tx, txUrl: txUrl(d.chainId, a.tx) ?? null })),
    },
  };
}

const plugin: Plugin = {
  name: "status",
  api: (app, d) => {
    let cached: { at: number; body: Awaited<ReturnType<typeof buildStatus>> } | null = null;
    app.get("/status", async (c) => {
      const now = d.now();
      if (!cached || now - cached.at >= CACHE_SEC || now < cached.at) cached = { at: now, body: await buildStatus(d) };
      c.header("Cache-Control", "public, max-age=5");
      return c.json(cached.body);
    });
  },
};

export default plugin;
