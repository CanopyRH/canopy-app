CREATE TABLE IF NOT EXISTS lp_reserve_snapshots (
  pool TEXT NOT NULL,
  at BIGINT NOT NULL,
  reserve0 NUMERIC(78,0) NOT NULL,
  reserve1 NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (pool, at)
);
CREATE INDEX IF NOT EXISTS lp_reserve_age ON lp_reserve_snapshots(at);
