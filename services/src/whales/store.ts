import type { Db } from "../store/db";
import type { Direction } from "./detect";

export interface MoveRow {
  tx: string; logIndex: number; block: bigint; at: number; vault: string; dir: Direction; whale: string; assets: bigint; decimals: number; symbol: string;
  usdCents: bigint; pctBps: number; liquidCents: bigint | null; alerted: boolean;
}

interface Raw {
  tx: string; log_index: number; block: string; at: string; vault: string; dir: Direction; whale: string; assets: string; decimals: number; symbol: string;
  usd_cents: string; pct_bps: number; liquid_cents: string | null; alerted: boolean; name?: string | null;
}

const fromRaw = (x: Raw): MoveRow & { name: string | null } => ({
  tx: x.tx, logIndex: Number(x.log_index), block: BigInt(x.block), at: Number(x.at), vault: x.vault, dir: x.dir, whale: x.whale, assets: BigInt(x.assets.split(".")[0]!),
  decimals: Number(x.decimals), symbol: x.symbol, usdCents: BigInt(x.usd_cents), pctBps: Number(x.pct_bps),
  liquidCents: x.liquid_cents === null ? null : BigInt(x.liquid_cents), alerted: x.alerted, name: x.name ?? null,
});

/** Days a recorded move is kept. */
export const KEEP_DAYS = 90;

export const whaleStore = (db: Db) => ({
  /** Records a move. A log read twice writes one row. Returns the row as stored, which a replay leaves as it was. */
  async record(m: Omit<MoveRow, "alerted">): Promise<MoveRow> {
    await db.query(
      `INSERT INTO whale_moves (tx, log_index, block, at, vault, dir, whale, assets, decimals, symbol, usd_cents, pct_bps, liquid_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (tx, log_index) DO NOTHING`,
      [m.tx, m.logIndex, m.block.toString(), m.at, m.vault, m.dir, m.whale, m.assets.toString(), m.decimals, m.symbol, m.usdCents.toString(), m.pctBps, m.liquidCents?.toString() ?? null],
    );
    const rows = await db.query<Raw>(`SELECT * FROM whale_moves WHERE tx=$1 AND log_index=$2`, [m.tx, m.logIndex]);
    return fromRaw(rows[0]!);
  },
  async markAlerted(tx: string, logIndex: number) {
    await db.query(`UPDATE whale_moves SET alerted=true WHERE tx=$1 AND log_index=$2`, [tx, logIndex]);
  },
  /** Alerts sent for a vault from `since` on, counted by the move's time. */
  async alertedSince(vault: string, since: number): Promise<number> {
    const r = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM whale_moves WHERE vault=$1 AND alerted AND at>=$2`, [vault, since]);
    return Number(r[0]?.n ?? 0);
  },
  /** Forgets the moves of blocks from `from` on, which a reorg dropped. If they are still on chain the re-read writes them again. */
  async undoFrom(from: bigint) {
    await db.query(`DELETE FROM whale_moves WHERE block>=$1`, [from.toString()]);
  },
  /** Newest first, with the vault's name from its risk card. */
  async recent(o: { vault?: string; limit: number }) {
    const rows = await db.query<Raw>(
      `SELECT m.*, c.numbers->>'name' AS name FROM whale_moves m LEFT JOIN risk_cards c ON c.target=m.vault
       WHERE ($1::text IS NULL OR m.vault=$1) ORDER BY m.at DESC, m.block DESC, m.log_index DESC LIMIT $2`,
      [o.vault ?? null, o.limit],
    );
    return rows.map(fromRaw);
  },
  async prune(now: number) {
    await db.query(`DELETE FROM whale_moves WHERE at<$1`, [now - KEEP_DAYS * 86_400]);
  },
});
export type WhaleStore = ReturnType<typeof whaleStore>;
