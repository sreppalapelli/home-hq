-- One row per assistant request: who asked, which provider and model answered, which tools ran.
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  from_id TEXT,
  prompt TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  ms INTEGER NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  reply TEXT,
  error TEXT
);
CREATE INDEX agent_runs_at ON agent_runs (at);

-- Changes the assistant may not make on its own (e.g. deleting an event): they wait here until a
-- person approves or cancels them on a frame or phone.
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_at INTEGER
);
CREATE INDEX approvals_status ON approvals (status, at);
