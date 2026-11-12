CREATE TABLE sync_file_rules (
  id serial PRIMARY KEY,
  failure_id integer NOT NULL REFERENCES sync_file_failures(id),
  source_id integer NOT NULL,
  source_root_id integer NOT NULL,
  destination_root_id text NOT NULL,
  destination_root_name text NOT NULL,
  action text NOT NULL CHECK (action IN ('ignore', 'overwrite')),
  expected_destination_id text,
  expected_etag text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_file_rules_scope_idx UNIQUE (source_id, source_root_id, destination_root_id)
);
