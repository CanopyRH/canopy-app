import type { Hono } from "hono";
import type { ApiDeps } from "../api/server";
import { ALARM_NAMES } from "../copy/alerts";
import type { Plugin } from "../plugins";

/** Mining time of a block in unix seconds, or null when it can't be read right now. */
export type BlockTime = (block: number) => Promise<number | null>;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Block times looked up per request, and the pause after a failed lookup, so a slow node can't be hammered. */
const FILL_PER_REQUEST = 50;
const RETRY_SEC = 30;

/** Reads a block's time from the chain's own RPC (read-only), trying the backup node if the first fails. */
export function rpcBlockTime(urls: string[] = [process.env.RPC_URL, process.env.RPC_URL_BACKUP].filter((u): u is string => !!u)): BlockTime {
  return async (block) => {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + block.toString(16), false] }),
          signal: AbortSignal.timeout(5_000),
        });
        const ts = ((await res.json()) as { result?: { timestamp?: string } }).result?.timestamp;
        if (ts) return Number(BigInt(ts));
      } catch {
        // try the next node
      }
    }
    return null;
  };
}

type Row = Record<string, string | number | boolean | null>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Stores the time of blocks that have exits but no time yet. Newest first, because those are the ones people look at. */
export function timeFiller(blockTime: BlockTime): (d: ApiDeps) => Promise<void> {
  let lastFail = -Infinity;
  return async (d) => {
    if (d.now() - lastFail < RETRY_SEC) return;
    const missing = await d.db.query<{ block: string }>(
      `SELECT DISTINCT e.block FROM exits e LEFT JOIN exit_times t ON t.block=e.block WHERE t.block IS NULL ORDER BY e.block DESC LIMIT ${FILL_PER_REQUEST}`,
    );
    const times = await Promise.all(missing.map(async (m) => [Number(m.block), await blockTime(Number(m.block)).catch(() => null)] as const));
    for (const [block, at] of times) {
      if (at === null) lastFail = d.now();
      else await d.db.query(`INSERT INTO exit_times (block, at) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [block, at]);
    }
  };
}

export function exitsPlugin(blockTime: BlockTime): Plugin {
  const fillTimes = timeFiller(blockTime);

  async function summary(d: ApiDeps) {
    const total = Number((await d.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM exits`))[0]?.n ?? 0);
    // Alarm-to-exit time per exit: the latest firing of that alarm at or before the exit.
    const s = (
      await d.db.query<{ n: string; median: string | null; longest: string | null }>(
        `SELECT COUNT(secs) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS median, MAX(secs) AS longest FROM (
           SELECT t.at - (SELECT MAX(a.fired_at) FROM alarms a WHERE a.key=e.alarm_key AND a.fired_at<=t.at) AS secs
           FROM exits e JOIN exit_times t ON t.block=e.block WHERE e.via_alarm
         ) x`,
      )
    )[0];
    return {
      total,
      timed: Number(s?.n ?? 0),
      medianSeconds: s?.median == null ? null : Math.round(Number(s.median)),
      longestSeconds: s?.longest == null ? null : Number(s.longest),
    };
  }

  return {
    name: "exits",
    api: (app: Hono, d: ApiDeps) => {
      app.get("/exits", async (c) => {
        const rawLimit = c.req.query("limit");
        const before = c.req.query("before");
        if ((rawLimit !== undefined && !/^\d{1,4}$/.test(rawLimit)) || (before !== undefined && !/^\d{1,18}$/.test(before))) return c.json({ error: "bad paging" }, 400);
        const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit)));

        await fillTimes(d);
        // One extra row tells us whether there is another page. Owner and caller are never selected.
        const rows = await d.db.query<Row>(
          `SELECT e.exit_id, e.alarm_key, e.via_alarm, e.tx, p.target, c.numbers->>'name' AS name, c.numbers->>'assetSymbol' AS symbol,
                  c.numbers->>'assetDecimals' AS decimals, det.kind, t.at
           FROM exits e
           LEFT JOIN positions p ON p.pos_id=e.pos_id
           LEFT JOIN risk_cards c ON c.target=p.target
           LEFT JOIN detectors det ON det.key=e.alarm_key
           LEFT JOIN exit_times t ON t.block=e.block
           WHERE ($1::bigint IS NULL OR e.exit_id < $1::bigint)
           ORDER BY e.exit_id DESC LIMIT $2`,
          [before ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const ids = page.map((r) => String(r.exit_id));
        const keys = [...new Set(page.filter((r) => r.via_alarm).map((r) => String(r.alarm_key)))];

        const payouts = ids.length
          ? await d.db.query<Row>(`SELECT exit_id, token, amount, swapped FROM exit_payouts WHERE exit_id = ANY($1::bigint[]) ORDER BY exit_id, log_index`, [ids])
          : [];
        const firings = keys.length ? await d.db.query<Row>(`SELECT key, fired_at FROM alarms WHERE key = ANY($1::text[]) ORDER BY fired_at`, [keys]) : [];

        const exits = page.map((r) => {
          const ranAt = num(r.at);
          const kind = num(r.kind);
          const fired = r.via_alarm
            ? (firings.filter((f) => f.key === r.alarm_key && (ranAt === null || Number(f.fired_at) <= ranAt)).map((f) => Number(f.fired_at)).at(-1) ?? null)
            : null;
          return {
            id: String(r.exit_id),
            vault: r.target ? { address: String(r.target), name: r.name ? String(r.name).slice(0, 80) : null } : null,
            alarm: r.via_alarm ? { key: String(r.alarm_key), name: ALARM_NAMES[kind ?? -1] ?? "an alarm", firedAt: fired } : null,
            ranAt,
            seconds: fired !== null && ranAt !== null ? ranAt - fired : null,
            paid: payouts
              .filter((p) => String(p.exit_id) === String(r.exit_id))
              .map((p) => ({
                token: String(p.token),
                amount: String(p.amount),
                // A swapped payout is in a different token than the vault's asset, so the card's symbol would be wrong.
                symbol: !p.swapped && r.symbol ? String(r.symbol) : null,
                decimals: !p.swapped && r.decimals != null ? Number(r.decimals) : null,
              })),
            tx: String(r.tx),
          };
        });
        return c.json({ summary: await summary(d), exits, next: rows.length > limit ? ids[ids.length - 1] : null });
      });
    },
  };
}

export default exitsPlugin(rpcBlockTime());
