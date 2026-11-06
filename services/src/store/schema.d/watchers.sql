-- Outside watchers: the AlarmBook's watcher list as it changed, and a 31-day log of the attestations the API took in.
CREATE TABLE IF NOT EXISTS watcher_events (tx TEXT NOT NULL, log_index INT NOT NULL, watcher TEXT NOT NULL, allowed BOOLEAN NOT NULL, block BIGINT NOT NULL, recorded_at BIGINT NOT NULL, PRIMARY KEY (tx, log_index));
CREATE INDEX IF NOT EXISTS watcher_events_watcher ON watcher_events (watcher, block DESC, log_index DESC);
CREATE TABLE IF NOT EXISTS watcher_attest_log (signer TEXT NOT NULL, key TEXT NOT NULL, evidence_hash TEXT NOT NULL, deadline BIGINT NOT NULL, seen_at BIGINT NOT NULL, PRIMARY KEY (signer, key, evidence_hash, deadline));
CREATE INDEX IF NOT EXISTS watcher_attest_log_seen ON watcher_attest_log (seen_at);
