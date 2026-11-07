-- Separate from paid_until time plans. No existing payment is silently converted to spendable credit.
CREATE TABLE IF NOT EXISTS credit_accounts (
  chain_id BIGINT NOT NULL, wallet TEXT NOT NULL,
  balance NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  PRIMARY KEY(chain_id,wallet)
);
CREATE TABLE IF NOT EXISTS credit_entries (
  id TEXT PRIMARY KEY, chain_id BIGINT NOT NULL, wallet TEXT NOT NULL,
  delta NUMERIC(78,0) NOT NULL, balance_after NUMERIC(78,0) NOT NULL CHECK(balance_after>=0),
  reason TEXT NOT NULL, terms_revision TEXT NOT NULL, evidence TEXT NOT NULL, at BIGINT NOT NULL,
  FOREIGN KEY(chain_id,wallet) REFERENCES credit_accounts(chain_id,wallet)
);
