import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ApiDeps } from "../api/server";
import { Kind, presetsFor } from "../api/presets";
import { sameSecret } from "../api/secret";
import { ALARM_NAMES } from "../copy/alerts";
import type { Plugin } from "../plugins";
import { rpcBlockTime, timeFiller, type BlockTime } from "./exits";

/** An alarm lives 24 hours (AlarmBook), so an exit counts as following it for that long. */
export const WINDOW = 86_400;
const CACHE_SEC = 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_NOTE = 500;
/** Exits linked per alarm. The count is always the full number. */
const MAX_EXIT_LINKS = 5;

export type Outcome = "exited" | "no_exit" | "no_armed_positions";
export type Verdict = "confirmed" | "false_alarm" | "unreviewed";
const OUTCOMES: Outcome[] = ["exited", "no_exit", "no_armed_positions"];

export interface AlarmRow {
  key: string;
  firedAt: number;
  vault: { address: string; name: string };
  alarm: {
    name: string;
    kind: string;
    /** "hard" fires from an on-chain rule alone. "quorum" needs approved watchers to sign. */
    rule: "hard" | "quorum";
    /** Approved watchers that signed, shortened. Only for quorum alarms. */
    signers: string[];
    /** The stored evidence hash, when the alarm has one. */
    evidence: string | null;
    tx: string | null;
  };
  outcome: Outcome;
  /** An alarm with armed positions and no exit yet, still inside its 24 hours. */
  open: boolean;
  exits: {
    count: number;
    firstAfterSeconds: number | null;
    returned: { token: string; amount: string; symbol: string | null; decimals: number | null }[];
    links: { tx: string; ranAt: number | null }[];
  };
  review: { verdict: Verdict; note: string; at: number | null };
}

export interface Summary {
  fired: { last7d: number; last30d: number; all: number };
  /** Alarms that had at least one exit within their 24 hours, and the exits behind them. */
  alarmsWithExit: number;
  exits: number;
  medianSecondsToExit: number | null;
  /** Armed positions, window closed, no exit. */
  noExit: number;
  noArmedPositions: number;
  falseAlarms: { falseAlarm: number; confirmed: number; unreviewed: number };
}

const KIND_NAMES = ["PRICE_BELOW", "SHARE_DROP", "PAUSED", "ADDRESS_CHANGE", "DRAIN", "QUORUM", "BOTH"];
const isQuorumKind = (k: number | null) => k === Kind.QUORUM || k === Kind.BOTH;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** Wallet addresses never appear in the record, not even in an operator's note. */
export const redact = (text: string) => text.replace(ADDRESS, "[address removed]");
const title = (n: string) => {
  const t = n.replace(/^(an?|the)\s+/i, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};

type Q = Record<string, string | number | boolean | null>;

/** Reads every fired alarm on a listed vault with what followed. */
export async function buildRecord(d: ApiDeps): Promise<{ rows: AlarmRow[]; summary: Summary }> {
  const vaults = await d.vaults();
  const listed = new Map(vaults.map((v) => [v.address.toLowerCase(), v.name]));
  const approved = new Set(d.watchers.map((w) => w.toLowerCase()));
  const now = d.now();

  const alarms = await d.db.query<Q>(
    `SELECT a.key, a.fired_at, a.tx, a.evidence, a.block, det.kind, det.target, det.b AS part
     FROM alarms a JOIN detectors det ON det.key=a.key`,
  );
  const mine = alarms.filter((a) => listed.has(String(a.target).toLowerCase()));
  const keys = [...new Set(mine.map((a) => String(a.key)))];

  // Preset names, matched on key. A key that no preset of that vault makes falls back to the kind's name.
  const names = new Map<string, string>();
  for (const v of vaults) for (const p of presetsFor(v.address, v.address, { paused: true })) names.set(p.key.toLowerCase(), p.name);

  const parts = [...new Set(mine.flatMap((a) => [String(a.key), String(a.part ?? "")]))].filter((k) => /^0x[0-9a-fA-F]{64}$/.test(k));
  const sigs = parts.length ? await d.db.query<Q>(`SELECT DISTINCT key, evidence_hash, signer FROM attestations WHERE key = ANY($1::text[])`, [parts]) : [];

  const exits = keys.length
    ? await d.db.query<Q>(
        `SELECT e.exit_id, e.alarm_key, e.tx, e.block, COALESCE(e.at, t.at) AS at
         FROM exits e LEFT JOIN exit_times t ON t.block=e.block WHERE e.via_alarm AND e.alarm_key = ANY($1::text[])`,
        [keys],
      )
    : [];
  const payouts = exits.length
    ? await d.db.query<Q>(`SELECT exit_id, token, amount, swapped FROM exit_payouts WHERE exit_id = ANY($1::bigint[])`, [exits.map((e) => String(e.exit_id))])
    : [];
  const armed = keys.length
    ? await d.db.query<Q>(`SELECT k.key, p.armed_block FROM position_keys k JOIN positions p ON p.pos_id=k.pos_id WHERE p.active AND k.key = ANY($1::text[])`, [keys])
    : [];
  const cards = await d.db.query<Q>(`SELECT target, numbers->>'assetSymbol' AS symbol, numbers->>'assetDecimals' AS decimals FROM risk_cards`);
  const card = new Map(cards.map((c) => [String(c.target).toLowerCase(), c]));
  const reviews = await d.db.query<Q>(`SELECT key, fired_at, verdict, note, at FROM alarm_reviews`);
  const review = new Map(reviews.map((r) => [`${r.key}:${r.fired_at}`, r]));

  // Firings of one key, oldest first, so an exit goes to the latest firing at or before it.
  const byKey = new Map<string, Q[]>();
  for (const a of [...mine].sort((x, y) => Number(x.fired_at) - Number(y.fired_at))) {
    const k = String(a.key);
    byKey.set(k, [...(byKey.get(k) ?? []), a]);
  }
  const attach = new Map<Q, Q[]>();
  for (const e of exits) {
    const firings = byKey.get(String(e.alarm_key)) ?? [];
    const at = e.at == null ? null : Number(e.at);
    let hit: Q | undefined;
    if (at !== null) {
      hit = firings.filter((f) => Number(f.fired_at) <= at).at(-1);
      if (hit && at - Number(hit.fired_at) > WINDOW) hit = undefined;
    } else {
      // A block time that could not be read yet. Go by block number so the exit is never silently dropped.
      hit = firings.filter((f) => f.block == null || Number(f.block) <= Number(e.block)).at(-1);
    }
    if (hit) attach.set(hit, [...(attach.get(hit) ?? []), e]);
  }

  const rows: AlarmRow[] = mine.map((a) => {
    const key = String(a.key);
    const firedAt = Number(a.fired_at);
    const kind = a.kind == null ? null : Number(a.kind);
    const target = String(a.target).toLowerCase();
    const quorum = isQuorumKind(kind);
    const ev = a.evidence ? String(a.evidence) : "";
    const evidence = /^0x[0-9a-fA-F]{64}$/.test(ev) && !/^0x0+$/.test(ev) ? ev : null;

    const signers = quorum
      ? [
          ...new Set(
            sigs
              .filter((s) => [key, String(a.part ?? "")].includes(String(s.key)) && (!evidence || String(s.evidence_hash) === evidence) && approved.has(String(s.signer).toLowerCase()))
              .map((s) => short(String(s.signer))),
          ),
        ].sort()
      : [];

    const mineExits = attach.get(a) ?? [];
    const times = mineExits.map((e) => (e.at == null ? null : Number(e.at))).filter((t): t is number => t !== null);
    const first = times.length ? Math.min(...times) - firedAt : null;
    const sums = new Map<string, { amount: bigint; swapped: boolean }>();
    for (const p of payouts.filter((p) => mineExits.some((e) => String(e.exit_id) === String(p.exit_id)))) {
      const t = String(p.token);
      const cur = sums.get(t) ?? { amount: 0n, swapped: false };
      sums.set(t, { amount: cur.amount + BigInt(String(p.amount).split(".")[0]!), swapped: cur.swapped || p.swapped === true });
    }
    const c = card.get(target);
    const returned = [...sums].map(([token, v]) => ({
      token,
      amount: v.amount.toString(),
      // A swapped payout is in another token than the vault's asset, so the card's symbol would be wrong.
      symbol: !v.swapped && c?.symbol ? String(c.symbol) : null,
      decimals: !v.swapped && c?.decimals != null ? Number(c.decimals) : null,
    }));
    const links = [...new Map(mineExits.map((e) => [String(e.tx), e])).values()]
      .slice(0, MAX_EXIT_LINKS)
      .map((e) => ({ tx: String(e.tx), ranAt: e.at == null ? null : Number(e.at) }));

    const hadArmed = armed.some((p) => String(p.key) === key && (a.block == null || Number(p.armed_block) <= Number(a.block)));
    const outcome: Outcome = mineExits.length ? "exited" : hadArmed ? "no_exit" : "no_armed_positions";
    const r = review.get(`${key}:${firedAt}`);
    return {
      key,
      firedAt,
      vault: { address: target, name: listed.get(target)!.slice(0, 80) },
      alarm: {
        name: names.get(key.toLowerCase()) ?? title(ALARM_NAMES[kind ?? -1] ?? "an alarm"),
        kind: KIND_NAMES[kind ?? -1] ?? "UNKNOWN",
        rule: quorum ? "quorum" : "hard",
        signers,
        evidence,
        tx: a.tx ? String(a.tx) : null,
      },
      outcome,
      open: outcome === "no_exit" && now - firedAt < WINDOW,
      exits: { count: mineExits.length, firstAfterSeconds: first, returned, links },
      review: { verdict: (r?.verdict as Verdict | undefined) ?? "unreviewed", note: r ? redact(String(r.note)).slice(0, MAX_NOTE) : "", at: r?.at == null ? null : Number(r.at) },
    };
  });
  rows.sort((x, y) => y.firedAt - x.firedAt || (x.key < y.key ? 1 : -1));

  const summary: Summary = {
    fired: {
      last7d: rows.filter((r) => now - r.firedAt <= 7 * 86400).length,
      last30d: rows.filter((r) => now - r.firedAt <= 30 * 86400).length,
      all: rows.length,
    },
    alarmsWithExit: rows.filter((r) => r.outcome === "exited").length,
    exits: rows.reduce((n, r) => n + r.exits.count, 0),
    medianSecondsToExit: median(rows.map((r) => r.exits.firstAfterSeconds).filter((s): s is number => s !== null)),
    noExit: rows.filter((r) => r.outcome === "no_exit" && !r.open).length,
    noArmedPositions: rows.filter((r) => r.outcome === "no_armed_positions").length,
    falseAlarms: {
      falseAlarm: rows.filter((r) => r.review.verdict === "false_alarm").length,
      confirmed: rows.filter((r) => r.review.verdict === "confirmed").length,
      unreviewed: rows.filter((r) => r.review.verdict === "unreviewed").length,
    },
  };
  return { rows, summary };
}

const ReviewBody = z.strictObject({
  key: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  firedAt: z.number().int().positive(),
  verdict: z.enum(["confirmed", "false_alarm", "unreviewed"]),
  note: z.string().max(MAX_NOTE).optional(),
});

export function alarmsPlugin(blockTime: BlockTime): Plugin {
  const fillTimes = timeFiller(blockTime);
  let cached: { at: number; value: Awaited<ReturnType<typeof buildRecord>> } | undefined;

  return {
    name: "alarms",
    api: (app: Hono, d: ApiDeps) => {
      const record = async () => {
        const age = cached ? d.now() - cached.at : Infinity;
        if (cached && age >= 0 && age < CACHE_SEC) return cached.value;
        await fillTimes(d).catch(() => undefined);
        cached = { at: d.now(), value: await buildRecord(d) };
        return cached.value;
      };

      app.get("/alarms/record", async (c) => {
        const rawLimit = c.req.query("limit");
        const before = c.req.query("before");
        const vault = c.req.query("vault");
        const outcome = c.req.query("outcome");
        const cursor = before === undefined ? null : /^(\d{1,12}):(0x[0-9a-fA-F]{64})$/.exec(before);
        if (
          (rawLimit !== undefined && !/^\d{1,4}$/.test(rawLimit)) ||
          (before !== undefined && !cursor) ||
          (vault !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(vault)) ||
          (outcome !== undefined && !OUTCOMES.includes(outcome as Outcome))
        ) return c.json({ error: "bad query" }, 400);
        const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit)));

        const { rows, summary } = await record();
        const pool = rows.filter((r) => (!vault || r.vault.address === vault.toLowerCase()) && (!outcome || r.outcome === outcome));
        const at = cursor ? Number(cursor[1]) : 0;
        const ck = cursor ? cursor[2]!.toLowerCase() : "";
        const start = cursor ? pool.findIndex((r) => r.firedAt < at || (r.firedAt === at && r.key.toLowerCase() < ck)) : 0;
        const page = start < 0 ? [] : pool.slice(start, start + limit);
        const last = page.at(-1);
        c.header("Cache-Control", `public, max-age=${CACHE_SEC}`);
        return c.json({
          summary,
          vaults: (await d.vaults()).map((v) => ({ address: v.address.toLowerCase(), name: v.name.slice(0, 80) })),
          total: pool.length,
          alarms: page,
          next: start >= 0 && start + limit < pool.length && last ? `${last.firedAt}:${last.key}` : null,
        });
      });

      // Operator-only. The same bearer token as the health check, and nothing is accepted without it.
      app.post("/alarms/review", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: "too large" }, 413) }), async (c) => {
        if (!d.healthToken || !sameSecret(c.req.header("authorization"), `Bearer ${d.healthToken}`)) return c.json({ error: "forbidden" }, 403);
        const parsed = ReviewBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ error: "bad body" }, 400);
        const b = parsed.data;
        const key = b.key.toLowerCase();
        if (!(await d.db.query(`SELECT 1 FROM alarms WHERE key=$1 AND fired_at=$2`, [key, b.firedAt])).length) return c.json({ error: "no such alarm" }, 404);
        await d.db.query(
          `INSERT INTO alarm_reviews (key, fired_at, verdict, note, at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (key, fired_at) DO UPDATE SET verdict=EXCLUDED.verdict, note=EXCLUDED.note, at=EXCLUDED.at`,
          [key, b.firedAt, b.verdict, redact(b.note ?? ""), d.now()],
        );
        cached = undefined;
        return c.json({ ok: true });
      });
    },
  };
}

export default alarmsPlugin(rpcBlockTime());
