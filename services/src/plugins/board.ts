import type { Address } from "viem";
import { txUrl } from "../chain/addresses";
import { buildBoard, STABLE_DECIMALS, type Board } from "../api/board";
import type { Plugin } from "../plugins";

/** Alarm names for the page, by AlarmBook.Kind: price, vault loss, paused, curator change, drain, exploit confirmed, combined. */
const ALARM_LABELS = ["Price", "Vault loss", "Paused", "Curator change", "Vault drain", "Exploit confirmed", "Combined alarm"];

/** How long one answer is reused. The page refreshes every 60 seconds, so this is also the page's freshness. */
export const BOARD_TTL = 60;

/**
 * GET /board, the armed board: public, read-only, under the API's per-address limit, and cached for 60 seconds so a
 * crowd on the page costs the database one pass a minute.
 *
 * Where each number comes from:
 * - Which positions are armed, and their owners: the `positions` table (active and confirmed rows).
 * - How many shares each owner can still exit: read on-chain by `ApiDeps.exitableShares` (balance, capped by the approval).
 * - Share price: the latest `vault_snaps` row of each vault, which the detector scan writes every pass. It is a cached
 *   chain reading, never a live call, so a request never waits on the RPC for prices.
 * - Exits and payouts: the `exits` and `exit_payouts` tables. Alarm to exit time: `exits.at` minus the newest
 *   `alarms.fired_at` for the exit's alarm key that is not after the exit. Alarms are pruned after 30 days, so older
 *   exits count in the totals but have no timing.
 * Only vaults on the approved list (`ApiDeps.vaults`) count, because anyone can deploy a vault with any share price.
 * It never returns a wallet address, only counts.
 */
const plugin: Plugin = {
  name: "board",
  api(app, d) {
    let cached: { at: number; body: Board } | undefined;
    let inflight: Promise<Board> | undefined;

    const compute = async (): Promise<Board> => {
      const now = d.now();
      const listed = await d.vaults();
      const addrs = listed.map((v) => v.address.toLowerCase());
      if (addrs.length === 0) return buildBoard({ now, vaults: [], positions: [], sharePrice: new Map(), exits: [], txUrl: () => undefined });

      const cards = await d.db.query<{ target: string; dec: string | null }>(`SELECT target, numbers->>'assetDecimals' AS dec FROM risk_cards WHERE target = ANY($1::text[])`, [addrs]);
      const decimals = new Map(cards.map((c) => [c.target, c.dec === null ? STABLE_DECIMALS : Number(c.dec)]));
      const vaults = listed.map((v) => ({ address: v.address.toLowerCase(), name: v.name || "Vault", assetDecimals: decimals.get(v.address.toLowerCase()) ?? STABLE_DECIMALS }));

      const rows = await d.db.query<{ owner: string; target: string }>(`SELECT owner, target FROM positions WHERE active AND confirmed AND target = ANY($1::text[])`, [addrs]);
      const reads = rows.map((r) => ({ target: r.target as Address, owner: r.owner as Address }));
      const shares = d.exitableShares ? await d.exitableShares(reads).catch(() => null) : null;
      const positions = rows.map((r, n) => ({ owner: r.owner, target: r.target, shares: shares?.[n] ?? null }));

      const snaps = await d.db.query<{ target: string; share_price: string }>(
        `SELECT DISTINCT ON (target) target, share_price::text AS share_price FROM vault_snaps WHERE target = ANY($1::text[]) ORDER BY target, t DESC`,
        [addrs],
      );
      const sharePrice = new Map(snaps.map((s) => [s.target, BigInt(s.share_price.split(".")[0]!)]));

      const exitRows = await d.db.query<{ exit_id: string; at: string | null; tx: string; target: string | null; kind: number | null; fired_at: string | null }>(
        `SELECT e.exit_id::text AS exit_id, e.at, e.tx, pos.target, det.kind,
                (SELECT MAX(a.fired_at) FROM alarms a WHERE e.at IS NOT NULL AND a.key=e.alarm_key AND a.fired_at<=e.at) AS fired_at
         FROM exits e JOIN positions pos ON pos.pos_id=e.pos_id LEFT JOIN detectors det ON det.key=e.alarm_key
         WHERE pos.target = ANY($1::text[])`,
        [addrs],
      );
      const paid = await d.db.query<{ exit_id: string; swapped: boolean; amount: string }>(
        `SELECT p.exit_id::text AS exit_id, p.swapped, SUM(p.amount)::text AS amount FROM exit_payouts p JOIN exits e ON e.exit_id=p.exit_id JOIN positions pos ON pos.pos_id=e.pos_id
         WHERE pos.target = ANY($1::text[]) GROUP BY p.exit_id, p.swapped`,
        [addrs],
      );
      const byExit = new Map<string, { amount: bigint; decimals: number }[]>();
      for (const p of paid) {
        const target = exitRows.find((e) => e.exit_id === p.exit_id)?.target;
        // A swapped payout is in the router's stablecoin. An unswapped one is the vault's own asset.
        const decimalsOf = p.swapped ? STABLE_DECIMALS : (target ? decimals.get(target) : undefined) ?? STABLE_DECIMALS;
        byExit.set(p.exit_id, [...(byExit.get(p.exit_id) ?? []), { amount: BigInt(p.amount.split(".")[0]!), decimals: decimalsOf }]);
      }
      const exits = exitRows.map((e) => ({
        exitId: e.exit_id,
        at: e.at === null ? null : Number(e.at),
        tx: e.tx,
        target: e.target,
        alarm: e.kind === null ? null : (ALARM_LABELS[Number(e.kind)] ?? null),
        firedAt: e.fired_at === null ? null : Number(e.fired_at),
        paid: byExit.get(e.exit_id) ?? [],
      }));

      return buildBoard({ now, vaults, positions, sharePrice, exits, txUrl: (tx) => txUrl(d.chainId, tx) });
    };

    app.get("/board", async (c) => {
      const t = d.now();
      if (!cached || t - cached.at >= BOARD_TTL) {
        inflight ??= compute().finally(() => void (inflight = undefined));
        try {
          cached = { at: t, body: await inflight };
        } catch {
          // Keep showing the last good answer for a while rather than an error page; with none, say so.
          if (!cached) return c.json({ error: "unavailable" }, 503);
        }
      }
      c.header("Cache-Control", `public, max-age=${BOARD_TTL}`);
      return c.json(cached.body);
    });
  },
};

export default plugin;
