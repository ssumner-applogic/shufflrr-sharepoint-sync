ALTER TABLE sync_config
  ADD COLUMN poll_interval_seconds integer NOT NULL DEFAULT 60
    CHECK (poll_interval_seconds IN (1, 5, 30, 60, 300, 3600)),
  ADD COLUMN next_run_at timestamptz,
  ADD COLUMN provider_retry_at timestamptz;

CREATE TABLE sync_sharepoint_state (
  drive_id text PRIMARY KEY,
  delta_link text NOT NULL
);
CREATE TABLE sync_sharepoint_items (
  drive_id text NOT NULL,
  item_id text NOT NULL,
  item jsonb NOT NULL
);
CREATE UNIQUE INDEX sync_sharepoint_snapshot_unique ON sync_sharepoint_items (drive_id, item_id);
