CREATE TABLE sync_file_failures (
 id serial PRIMARY KEY,
 source_id integer NOT NULL,
 source_root_id integer NOT NULL,
 parent_id integer NOT NULL,
 file_history_id integer,
 ancestor_ids jsonb NOT NULL,
 destination_root_id text NOT NULL,
 portal_origin text NOT NULL,
 name text NOT NULL,
 path text NOT NULL,
 reason text NOT NULL,
 fingerprint text NOT NULL,
 last_failed_at timestamptz NOT NULL DEFAULT now(),
 dismissed_at timestamptz,
 resolved_at timestamptz,
 retry_requested_at timestamptz
);
CREATE UNIQUE INDEX sync_file_failure_scope_idx ON sync_file_failures(source_id, source_root_id, destination_root_id);
CREATE INDEX sync_file_failure_pending_idx ON sync_file_failures(resolved_at, retry_requested_at);
CREATE INDEX sync_file_failure_destination_idx ON sync_file_failures(destination_root_id, resolved_at);
