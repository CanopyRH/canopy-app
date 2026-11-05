-- When each block with an exit was mined. The indexer stores only block numbers, so the exit log fills this in on demand.
CREATE TABLE IF NOT EXISTS exit_times (block BIGINT PRIMARY KEY, at BIGINT NOT NULL);
