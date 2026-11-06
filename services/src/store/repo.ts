import type { Db } from "./db";

export interface PositionRow {
  pos_id: string;
  owner: string;
  adapter: string;
  target: string;
  token_id: string;
  active: boolean;
  epoch: string;
}

export const repo = (db: Db) => ({
  async upsertPosition(p: {
    posId: string; owner: string; adapter: string; target: string; tokenId: bigint; harbour: number; maxSlipBps: number;
    epoch: bigint; block: bigint; termsHash: string; keys: readonly string[];
  }) {
    await db.query(
      `INSERT INTO positions (pos_id, owner, adapter, target, token_id, harbour, max_slip_bps, epoch, active, armed_block, terms_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)
       ON CONFLICT (pos_id) DO UPDATE SET harbour=$6, max_slip_bps=$7, epoch=$8, active=true, armed_block=$9, terms_hash=$10`,
      [p.posId, p.owner, p.adapter, p.target, p.tokenId.toString(), p.harbour, p.maxSlipBps, p.epoch.toString(), p.block.toString(), p.termsHash],
    );
    await db.query(`DELETE FROM position_keys WHERE pos_id=$1`, [p.posId]);
    for (const k of p.keys) await db.query(`INSERT INTO position_keys (pos_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p.posId, k]);
  },
  async epochOf(owner: string): Promise<bigint> {
    const r = await db.query<{ epoch: string }>(`SELECT epoch FROM owner_epochs WHERE owner=$1`, [owner]);
    return BigInt(r[0]?.epoch ?? 0);
  },
  async disarm(posId: string) {
    await db.query(`UPDATE positions SET active=false WHERE pos_id=$1`, [posId]);
  },
  async disarmAll(owner: string, epoch: bigint) {
    await db.query(`INSERT INTO owner_epochs (owner, epoch) VALUES ($1,$2) ON CONFLICT (owner) DO UPDATE SET epoch=$2`, [owner, epoch.toString()]);
    await db.query(`UPDATE positions SET active=false WHERE owner=$1 AND epoch<$2`, [owner, epoch.toString()]);
  },
  async armedWith(key: string): Promise<PositionRow[]> {
    return db.query<PositionRow>(
      `SELECT p.* FROM positions p JOIN position_keys k ON k.pos_id=p.pos_id WHERE k.key=$1 AND p.active`,
      [key],
    );
  },
  /** Vaults affected by an alarm, whichever contract the alarm itself watches. */
  async vaultsFor(key: string): Promise<string[]> {
    const r = await db.query<{ target: string }>(`SELECT DISTINCT p.target FROM positions p JOIN position_keys k ON k.pos_id=p.pos_id WHERE k.key=$1`, [key]);
    return r.map((x) => x.target);
  },
  async firedSince(key: string, since: number): Promise<boolean> {
    return (await db.query(`SELECT 1 FROM alarms WHERE key=$1 AND fired_at>$2 LIMIT 1`, [key, since])).length > 0;
  },
  /**
   * Armed keys, plus the parts of any armed BOTH key. Each part has to fire on its own before the BOTH can.
   * With `paidAfter`, only keys armed by a wallet with a live plan, so an unpaid key can't spend Canopy's gas.
   */
  async liveKeys(paidAfter?: number): Promise<string[]> {
    const paid = paidAfter === undefined ? "" : `JOIN plans pl ON pl.wallet=p.owner AND pl.paid_until>${Number(paidAfter)}`;
    const r = await db.query<{ key: string }>(
      `WITH armed AS (SELECT DISTINCT k.key FROM position_keys k JOIN positions p ON p.pos_id=k.pos_id ${paid} WHERE p.active)
       SELECT key FROM armed
       UNION SELECT d.a FROM detectors d JOIN armed USING (key) WHERE d.kind=6
       UNION SELECT d.b FROM detectors d JOIN armed USING (key) WHERE d.kind=6`,
    );
    return r.map((x) => x.key);
  },
  /** Live keys of one detector kind, for baseline upkeep. */
  async liveKeysOfKind(kind: number, paidAfter?: number): Promise<string[]> {
    const ofKind = new Set((await db.query<{ key: string }>(`SELECT key FROM detectors WHERE kind=$1`, [kind])).map((x) => x.key));
    return (await this.liveKeys(paidAfter)).filter((k) => ofKind.has(k));
  },
  async paidUntil(wallet: string): Promise<number | null> {
    const r = await db.query<{ paid_until: string }>(`SELECT paid_until FROM plans WHERE wallet=$1`, [wallet]);
    return r[0] ? Number(r[0].paid_until) : null;
  },
  async setPaidUntil(wallet: string, until: number) {
    await db.query(`INSERT INTO plans (wallet, paid_until) VALUES ($1,$2) ON CONFLICT (wallet) DO UPDATE SET paid_until=$2`, [wallet, until]);
  },
  /** Records a payment once. Returns false if this log was already fully applied. */
  async recordPayment(p: { tx: string; logIndex: number; wallet: string; amount: bigint; credited: boolean; at: number }) {
    await db.query(
      `INSERT INTO plan_payments (tx, log_index, wallet, amount, credited, at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [p.tx, p.logIndex, p.wallet, p.amount.toString(), p.credited, p.at],
    );
    const r = await db.query<{ applied: boolean }>(`SELECT applied FROM plan_payments WHERE tx=$1 AND log_index=$2`, [p.tx, p.logIndex]);
    return r[0]?.applied === false;
  },
  /** Marks a payment applied and extends the plan in one statement, so a failure can't lose the plan or credit it twice. */
  async applyPayment(tx: string, logIndex: number, wallet: string, until: number | null) {
    if (until === null) {
      await db.query(`UPDATE plan_payments SET applied=true WHERE tx=$1 AND log_index=$2`, [tx, logIndex]);
      return;
    }
    await db.query(
      `WITH done AS (UPDATE plan_payments SET applied=true WHERE tx=$1 AND log_index=$2 AND NOT applied RETURNING 1)
       INSERT INTO plans (wallet, paid_until) SELECT $3,$4 FROM done ON CONFLICT (wallet) DO UPDATE SET paid_until=$4`,
      [tx, logIndex, wallet, until],
    );
  },
  async followCount(chatId: number): Promise<number> {
    return (await db.query(`SELECT 1 FROM vault_follows WHERE chat_id=$1`, [chatId])).length;
  },
  async follow(chatId: number, target: string) {
    await db.query(`INSERT INTO vault_follows (chat_id, target) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [chatId, target]);
  },
  async unfollow(chatId: number, target: string) {
    await db.query(`DELETE FROM vault_follows WHERE chat_id=$1 AND target=$2`, [chatId, target]);
  },
  async following(chatId: number): Promise<string[]> {
    return (await db.query<{ target: string }>(`SELECT target FROM vault_follows WHERE chat_id=$1 ORDER BY target`, [chatId])).map((x) => x.target);
  },
  async followers(target: string): Promise<number[]> {
    return (await db.query<{ chat_id: string }>(`SELECT chat_id FROM vault_follows WHERE target=$1`, [target])).map((x) => Number(x.chat_id));
  },
  async cursor(name: string): Promise<bigint | null> {
    const r = await db.query<{ block: string }>(`SELECT block FROM cursors WHERE name=$1`, [name]);
    return r[0] ? BigInt(r[0].block) : null;
  },
  async setCursor(name: string, block: bigint) {
    await db.query(`INSERT INTO cursors (name, block) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET block=$2`, [name, block.toString()]);
  },
  async enqueue(kind: string, dedupe: string, payload: unknown, runAt: number) {
    await db.query(`INSERT INTO jobs (kind, dedupe, payload, run_at, created_at) VALUES ($1,$2,$3::text::jsonb,$4,$4) ON CONFLICT (dedupe) DO NOTHING`, [kind, dedupe, JSON.stringify(payload), runAt]);
  },
  async dueJobs(kind: string, now: number, limit = 32) {
    return db.query<{ id: string; payload: unknown; attempts: number }>(
      `SELECT id, payload, attempts FROM jobs WHERE kind=$1 AND NOT done AND run_at<=$2 ORDER BY run_at LIMIT $3`,
      [kind, now, limit],
    );
  },
  async finishJob(id: string) {
    await db.query(`UPDATE jobs SET done=true WHERE id=$1`, [id]);
  },
  async retryJob(id: string, runAt: number) {
    await db.query(`UPDATE jobs SET attempts=attempts+1, run_at=$2 WHERE id=$1`, [id, runAt]);
  },
  async recordAlarm(key: string, firedAt: number, tx: string | null, evidence: string) {
    await db.query(`INSERT INTO alarms (key, fired_at, tx, evidence) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [key, firedAt, tx, evidence]);
  },
  async recordSnap(target: string, t: number, totalAssets: bigint, sharePrice: bigint) {
    await db.query(`INSERT INTO vault_snaps (target, t, total_assets, share_price) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [target, t, totalAssets.toString(), sharePrice.toString()]);
  },
  async snaps(target: string, since: number) {
    const rows = await db.query<{ t: string; total_assets: string }>(`SELECT t, total_assets FROM vault_snaps WHERE target=$1 AND t>=$2 ORDER BY t`, [target, since]);
    return rows.map((x) => ({ t: Number(x.t), totalAssets: BigInt(x.total_assets) }));
  },
  /** Claims the right to send one alert. Any operator process can call this, and only one wins within the quiet period. */
  async claimAlert(target: string, kind: string, now: number, quietSec = 86_400): Promise<boolean> {
    const r = await db.query(
      `INSERT INTO sent_alerts (target, kind, at) VALUES ($1,$2,$3) ON CONFLICT (target, kind) DO UPDATE SET at=$3 WHERE sent_alerts.at<=$4 RETURNING at`,
      [target, kind, now, now - quietSec],
    );
    return r.length > 0;
  },
  async highSharePrice(target: string, since: number): Promise<bigint> {
    const r = await db.query<{ high: string | null }>(`SELECT MAX(share_price)::text AS high FROM vault_snaps WHERE target=$1 AND t>=$2`, [target, since]);
    return BigInt(r[0]?.high ?? 0);
  },
  /** Cards for an approved list only. A vault's name comes from the vault, so anything else would let a stranger write to this list. */
  async cardList(approved: string[]) {
    const rows = await db.query<{ target: string; name: string | null; asset: string | null }>(`SELECT target, numbers->>'name' AS name, numbers->>'assetSymbol' AS asset FROM risk_cards ORDER BY name`);
    return rows.filter((x) => approved.includes(x.target));
  },
  async detectorTarget(key: string): Promise<string | null> {
    const r = await db.query<{ target: string }>(`SELECT target FROM detectors WHERE key=$1`, [key]);
    return r[0]?.target ?? null;
  },
  async detectorKind(key: string): Promise<number | null> {
    const r = await db.query<{ kind: number }>(`SELECT kind FROM detectors WHERE key=$1`, [key]);
    return r[0] ? Number(r[0].kind) : null;
  },
  async recordExit(e: { exitId: bigint; posId: string; owner: string; caller: string; alarmKey: string; viaAlarm: boolean; tx: string; block: bigint }) {
    await db.query(
      `INSERT INTO exits (exit_id, pos_id, owner, caller, alarm_key, via_alarm, tx, block) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [e.exitId.toString(), e.posId, e.owner, e.caller, e.alarmKey, e.viaAlarm, e.tx, e.block.toString()],
    );
  },
  async recordPayout(p: { exitId: bigint; tx: string; logIndex: number; token: string; amount: bigint; swapped: boolean }) {
    await db.query(
      `INSERT INTO exit_payouts (exit_id, tx, log_index, token, amount, swapped) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [p.exitId.toString(), p.tx, p.logIndex, p.token, p.amount.toString(), p.swapped],
    );
  },
  /** Only the first sight of each log changes the balance, so a replay can't double it. */
  async addOwed(tx: string, logIndex: number, owner: string, token: string, amount: bigint) {
    const fresh = await db.query(`INSERT INTO owed_logs (tx, log_index) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING tx`, [tx, logIndex]);
    if (fresh.length === 0) return;
    await db.query(`INSERT INTO owed (owner, token, amount) VALUES ($1,$2,$3) ON CONFLICT (owner, token) DO UPDATE SET amount=owed.amount+$3`, [owner, token, amount.toString()]);
  },
  async clearOwed(owner: string, token: string) {
    await db.query(`DELETE FROM owed WHERE owner=$1 AND token=$2`, [owner, token]);
  },
  async openOwed() {
    return db.query<{ owner: string; token: string; amount: string }>(`SELECT owner, token, amount FROM owed`);
  },
  async recentAlarms(since: number) {
    return db.query<{ key: string; fired_at: string }>(`SELECT key, fired_at FROM alarms WHERE fired_at>$1`, [since]);
  },
  /** Attestation sets that already have enough signers. Whichever process holds the keeper key sends them. */
  async quorumReady(k: number, now: number) {
    return db.query<{ key: string; evidence_hash: string; deadline: string }>(
      `SELECT key, evidence_hash, deadline FROM attestations WHERE deadline>$2 GROUP BY key, evidence_hash, deadline HAVING COUNT(DISTINCT signer)>=$1`,
      [k, now],
    );
  },
  async bump(name: string) {
    await db.query(`INSERT INTO counters (name, value) VALUES ($1,1) ON CONFLICT (name) DO UPDATE SET value=counters.value+1`, [name]);
  },
  async setCounter(name: string, value: bigint) {
    await db.query(`INSERT INTO counters (name, value) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET value=$2`, [name, value.toString()]);
  },
  /** Operator numbers. Nothing here names a wallet. */
  async health(now: number) {
    const [jobs] = await db.query<{ open: string; oldest: string | null }>(`SELECT COUNT(*)::text AS open, MIN(created_at)::text AS oldest FROM jobs WHERE NOT done`);
    const counters = await db.query<{ name: string; value: string }>(`SELECT name, value::text AS value FROM counters ORDER BY name`);
    const cursors = await db.query<{ name: string; block: string }>(`SELECT name, block::text AS block FROM cursors`);
    const [exits] = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM exits WHERE via_alarm`);
    const [signers] = await db.query<{ n: string }>(`SELECT COUNT(DISTINCT signer)::text AS n FROM attestations WHERE deadline>$1`, [now - 7 * 86_400]);
    return {
      openJobs: Number(jobs?.open ?? 0),
      oldestJobSec: jobs?.oldest ? Math.max(0, now - Number(jobs.oldest)) : 0,
      alarmExits: Number(exits?.n ?? 0),
      watchersSeen7d: Number(signers?.n ?? 0),
      counters: Object.fromEntries(counters.map((c) => [c.name, c.value])),
      cursors: Object.fromEntries(cursors.map((c) => [c.name, c.block])),
    };
  },
  async admins(target: string) {
    return (await db.query<{ owner: string | null; curator: string | null }>(`SELECT owner, curator FROM vault_admins WHERE target=$1`, [target]))[0] ?? null;
  },
  async saveAdmins(target: string, a: { owner: string | null; curator: string | null }) {
    await db.query(`INSERT INTO vault_admins (target, owner, curator) VALUES ($1,$2,$3) ON CONFLICT (target) DO UPDATE SET owner=$2, curator=$3`, [target, a.owner, a.curator]);
  },
  async recordSignal(s: { kind: string; target: string; severity: string; value: number; evidence: string; at: number }) {
    await db.query(`INSERT INTO signals (kind, target, severity, value, evidence, at) VALUES ($1,$2,$3,$4,$5,$6)`, [s.kind, s.target, s.severity, s.value, s.evidence, s.at]);
  },
  async recentSignals(target: string, since: number) {
    const rows = await db.query<{ kind: string; target: string; severity: string; value: string; evidence: string; at: string }>(
      `SELECT kind, target, severity, value, evidence, at FROM signals WHERE target=$1 AND at>$2 ORDER BY id`, [target, since],
    );
    return rows.map((x) => ({ ...x, value: Number(x.value), at: Number(x.at) }));
  },
  async saveCard(target: string, numbers: unknown, text: string, at: number) {
    await db.query(
      `INSERT INTO risk_cards (target, numbers, text, updated_at) VALUES ($1,$2::text::jsonb,$3,$4) ON CONFLICT (target) DO UPDATE SET numbers=$2::text::jsonb, text=$3, updated_at=$4`,
      [target, JSON.stringify(numbers), text, at],
    );
  },
  async card(target: string) {
    return (await db.query<{ numbers: unknown; text: string; updated_at: string }>(`SELECT numbers, text, updated_at FROM risk_cards WHERE target=$1`, [target]))[0] ?? null;
  },
});

export type Repo = ReturnType<typeof repo>;
