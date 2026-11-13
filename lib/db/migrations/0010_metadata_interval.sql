ALTER TABLE metadata_control
  ADD COLUMN interval_seconds integer
  CHECK (interval_seconds IN (300, 600, 900, 3600));
