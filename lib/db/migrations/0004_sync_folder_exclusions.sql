ALTER TABLE sync_config ADD COLUMN excluded_folders jsonb NOT NULL DEFAULT '[]'::jsonb;
