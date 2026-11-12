ALTER TABLE sync_config
  ADD COLUMN treat_archived_as_deleted boolean NOT NULL DEFAULT false;
