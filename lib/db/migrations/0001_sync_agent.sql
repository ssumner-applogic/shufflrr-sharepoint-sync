CREATE TABLE IF NOT EXISTS "sync_config" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "destination_folder_id" text,
  "destination_folder_name" text,
  "source_folders" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_run_status" text,
  "last_run_summary" jsonb,
  "last_run_conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_run_error" text
);

CREATE TABLE IF NOT EXISTS "sync_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "source_root_id" text NOT NULL,
  "source_root_name" text NOT NULL,
  "source_id" text NOT NULL,
  "source_is_folder" boolean NOT NULL,
  "source_parent_id" text,
  "destination_root_id" text NOT NULL,
  "destination_root_name" text NOT NULL,
  "destination_id" text NOT NULL,
  "relative_path" text NOT NULL,
  "name" text NOT NULL,
  "source_modified_at" text,
  "source_size" integer DEFAULT 0 NOT NULL,
  "destination_c_tag" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "sync_items_scope_source_unique"
  ON "sync_items" ("source_root_id", "source_id", "source_is_folder", "destination_root_id");
CREATE INDEX IF NOT EXISTS "sync_items_destination_root_idx"
  ON "sync_items" ("destination_root_id");

CREATE TABLE IF NOT EXISTS "sync_orphan_notices" (
  "id" serial PRIMARY KEY NOT NULL,
  "source_root_id" text NOT NULL,
  "source_root_name" text NOT NULL,
  "destination_folder_id" text NOT NULL,
  "destination_folder_name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dismissed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "sync_orphan_notices_active_idx"
  ON "sync_orphan_notices" ("dismissed_at", "created_at");
