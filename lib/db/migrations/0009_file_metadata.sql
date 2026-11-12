CREATE TABLE IF NOT EXISTS file_metadata (
  id serial PRIMARY KEY,
  drive_id text NOT NULL, item_id text NOT NULL, source_portal text NOT NULL,
  source_file_id integer NOT NULL, source_root_id text NOT NULL, destination_root_id text NOT NULL,
  fields jsonb, fingerprint text, observed_at timestamptz,
  last_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text
);
CREATE UNIQUE INDEX IF NOT EXISTS file_metadata_binding_unique
  ON file_metadata (drive_id, item_id, source_portal, source_file_id);
CREATE INDEX IF NOT EXISTS file_metadata_lookup_idx ON file_metadata (drive_id, item_id);
CREATE TABLE IF NOT EXISTS metadata_control (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  requested_at timestamptz, handled_at timestamptz, next_crawl_at timestamptz NOT NULL DEFAULT now(),
  worker_last_seen_at timestamptz, last_sync_finished_at timestamptz, retry_at timestamptz
);
CREATE TABLE IF NOT EXISTS metadata_runs (
  id uuid PRIMARY KEY, scope_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','success','partial','failed')),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  total_files integer NOT NULL DEFAULT 0, processed_files integer NOT NULL DEFAULT 0,
  refreshed_files integer NOT NULL DEFAULT 0, unchanged_files integer NOT NULL DEFAULT 0,
  failed_files integer NOT NULL DEFAULT 0, skipped_files integer NOT NULL DEFAULT 0,
  sample_limit integer, error text
);
CREATE INDEX IF NOT EXISTS metadata_runs_scope_idx ON metadata_runs (scope_key, started_at);
CREATE TABLE IF NOT EXISTS metadata_events (
  id serial PRIMARY KEY, run_id uuid NOT NULL REFERENCES metadata_runs(id) ON DELETE CASCADE,
  drive_id text NOT NULL, item_id text NOT NULL, name text NOT NULL,
  status text NOT NULL CHECK (status IN ('refreshed','unchanged','failed','skipped')),
  message text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS metadata_events_run_idx ON metadata_events (run_id, id);
