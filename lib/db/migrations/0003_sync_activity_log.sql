CREATE TABLE sync_runs (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial', 'failed')),
  summary jsonb,
  error text
);
CREATE INDEX sync_runs_started_idx ON sync_runs (started_at);
CREATE TABLE sync_run_events (
  id serial PRIMARY KEY,
  run_id text NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN
    ('created', 'copied', 'updated', 'moved', 'deleted', 'unchanged', 'conflict', 'failed', 'skipped')),
  path text,
  destination_path text,
  item_type text NOT NULL CHECK (item_type IN ('file', 'folder', 'run')),
  message text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_run_events_page_idx ON sync_run_events (run_id, status, id);
CREATE INDEX sync_run_events_run_idx ON sync_run_events (run_id, id);
