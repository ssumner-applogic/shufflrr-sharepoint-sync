CREATE TABLE sync_file_failure_issues (
  id serial PRIMARY KEY,
  failure_id integer NOT NULL REFERENCES sync_file_failures(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('failed', 'conflict', 'skipped')),
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_file_failure_issue_history_idx ON sync_file_failure_issues(failure_id, occurred_at, id);
CREATE INDEX sync_file_failure_issue_run_idx ON sync_file_failure_issues(run_id);
