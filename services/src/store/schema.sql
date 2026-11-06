CREATE TABLE IF NOT EXISTS plans (wallet TEXT PRIMARY KEY, paid_until BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS plan_payments (tx TEXT, log_index INT, wallet TEXT NOT NULL, amount NUMERIC NOT NULL, credited BOOLEAN NOT NULL DEFAULT false, applied BOOLEAN NOT NULL DEFAULT false, at BIGINT NOT NULL, PRIMARY KEY (tx, log_index));
CREATE TABLE IF NOT EXISTS vault_follows (chat_id BIGINT, target TEXT, PRIMARY KEY (chat_id, target));
CREATE TABLE IF NOT EXISTS positions (pos_id TEXT PRIMARY KEY, owner TEXT NOT NULL, adapter TEXT NOT NULL, target TEXT NOT NULL, token_id NUMERIC NOT NULL,
  harbour SMALLINT NOT NULL, max_slip_bps INT NOT NULL, epoch BIGINT NOT NULL, active BOOLEAN NOT NULL, armed_block BIGINT NOT NULL, terms_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS positions_owner ON positions (owner);
CREATE INDEX IF NOT EXISTS positions_target ON positions (target) WHERE active;
CREATE TABLE IF NOT EXISTS owner_epochs (owner TEXT PRIMARY KEY, epoch BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS position_keys (pos_id TEXT REFERENCES positions ON DELETE CASCADE, key TEXT NOT NULL, PRIMARY KEY (pos_id, key));
CREATE INDEX IF NOT EXISTS position_keys_key ON position_keys (key);
CREATE TABLE IF NOT EXISTS detectors (key TEXT PRIMARY KEY, kind SMALLINT, target TEXT, threshold NUMERIC, window_s BIGINT, a TEXT, b TEXT);
CREATE TABLE IF NOT EXISTS vault_snaps (target TEXT, t BIGINT, total_assets NUMERIC, share_price NUMERIC, PRIMARY KEY (target, t));
CREATE TABLE IF NOT EXISTS vault_admins (target TEXT PRIMARY KEY, owner TEXT, curator TEXT);
CREATE TABLE IF NOT EXISTS signals (id BIGSERIAL PRIMARY KEY, kind TEXT, target TEXT, severity TEXT, value NUMERIC, evidence TEXT, at BIGINT);
CREATE TABLE IF NOT EXISTS feed_items (sha256 TEXT PRIMARY KEY, source_url TEXT, raw TEXT, label TEXT, protocol TEXT, confidence REAL, at BIGINT, tries INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS alarms (key TEXT, fired_at BIGINT, tx TEXT, evidence TEXT, PRIMARY KEY (key, fired_at));
CREATE TABLE IF NOT EXISTS attestations (key TEXT, evidence_hash TEXT, deadline BIGINT, signer TEXT, sig TEXT, PRIMARY KEY (key, evidence_hash, deadline, signer));
CREATE TABLE IF NOT EXISTS exits (exit_id BIGINT PRIMARY KEY, pos_id TEXT, owner TEXT, caller TEXT, alarm_key TEXT, via_alarm BOOLEAN, tx TEXT, block BIGINT);
CREATE TABLE IF NOT EXISTS exit_payouts (exit_id BIGINT, tx TEXT, log_index INT, token TEXT, amount NUMERIC, swapped BOOLEAN, PRIMARY KEY (tx, log_index));
CREATE TABLE IF NOT EXISTS risk_cards (target TEXT PRIMARY KEY, numbers JSONB, text TEXT, updated_at BIGINT);
CREATE TABLE IF NOT EXISTS jobs (id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, dedupe TEXT UNIQUE NOT NULL, payload JSONB NOT NULL, run_at BIGINT NOT NULL, created_at BIGINT NOT NULL, attempts INT NOT NULL DEFAULT 0, done BOOLEAN NOT NULL DEFAULT false);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (run_at) WHERE NOT done;
CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, block BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS sent_alerts (target TEXT, kind TEXT, at BIGINT NOT NULL, PRIMARY KEY (target, kind));
CREATE TABLE IF NOT EXISTS owed (owner TEXT, token TEXT, amount NUMERIC NOT NULL, PRIMARY KEY (owner, token));
CREATE TABLE IF NOT EXISTS owed_logs (tx TEXT, log_index INT, PRIMARY KEY (tx, log_index));
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value NUMERIC NOT NULL);
CREATE TABLE IF NOT EXISTS log_retries (source TEXT NOT NULL, tx TEXT NOT NULL, log_index INT NOT NULL, subject TEXT NOT NULL DEFAULT '', block BIGINT NOT NULL, log JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0, first_failed_at BIGINT NOT NULL, next_at BIGINT NOT NULL, last_error TEXT NOT NULL DEFAULT '', alerted BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (source, tx, log_index));
