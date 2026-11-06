-- An operator's verdict on one fired alarm, for the public alarm record. No row means unreviewed.
CREATE TABLE IF NOT EXISTS alarm_reviews (
  key TEXT NOT NULL,
  fired_at BIGINT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'false_alarm', 'unreviewed')),
  note TEXT NOT NULL DEFAULT '',
  at BIGINT NOT NULL,
  PRIMARY KEY (key, fired_at)
);
