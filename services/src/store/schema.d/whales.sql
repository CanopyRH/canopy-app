-- Whale alerts (src/plugins/whales.ts): one row per large ERC-4626 deposit or withdrawal on a listed vault.
-- (tx, log_index) is the log's identity, so reading a log twice writes one row. `alerted` is set once the follower alert is queued.
CREATE TABLE IF NOT EXISTS whale_moves (
  tx TEXT NOT NULL, log_index INT NOT NULL, block BIGINT NOT NULL, at BIGINT NOT NULL, vault TEXT NOT NULL,
  dir TEXT NOT NULL CHECK (dir IN ('in', 'out')), whale TEXT NOT NULL, assets NUMERIC NOT NULL, decimals SMALLINT NOT NULL, symbol TEXT NOT NULL,
  usd_cents BIGINT NOT NULL, pct_bps INT NOT NULL, liquid_cents BIGINT, alerted BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX IF NOT EXISTS whale_moves_vault_at ON whale_moves (vault, at DESC);
CREATE INDEX IF NOT EXISTS whale_moves_at ON whale_moves (at DESC);
CREATE INDEX IF NOT EXISTS whale_moves_block ON whale_moves (block);
