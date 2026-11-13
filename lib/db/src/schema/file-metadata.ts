import { integer, pgTable, serial, text, timestamp, jsonb, uniqueIndex, index, uuid } from "drizzle-orm/pg-core";

/** No foreign-key cascade: removing a live sync mapping must not erase provenance. */
export const fileMetadataTable = pgTable("file_metadata", {
  id: serial("id").primaryKey(),
  driveId: text("drive_id").notNull(),
  itemId: text("item_id").notNull(),
  sourcePortal: text("source_portal").notNull(),
  sourceFileId: integer("source_file_id").notNull(),
  sourceRootId: text("source_root_id").notNull(),
  destinationRootId: text("destination_root_id").notNull(),
  fields: jsonb("fields").$type<Record<string, string | number | null>>(),
  fingerprint: text("fingerprint"),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
}, table => [
  uniqueIndex("file_metadata_binding_unique").on(table.driveId, table.itemId, table.sourcePortal, table.sourceFileId),
  index("file_metadata_lookup_idx").on(table.driveId, table.itemId),
]);

/** One coalescing request, never an unbounded backlog of polling jobs. */
export const metadataControlTable = pgTable("metadata_control", {
  id: integer("id").primaryKey().default(1),
  requestedAt: timestamp("requested_at", { withTimezone: true }),
  handledAt: timestamp("handled_at", { withTimezone: true }),
  intervalSeconds: integer("interval_seconds"),
  lastSyncFinishedAt: timestamp("last_sync_finished_at", { withTimezone: true }),
  retryAt: timestamp("retry_at", { withTimezone: true }),
  nextCrawlAt: timestamp("next_crawl_at", { withTimezone: true }).notNull().defaultNow(),
  workerLastSeenAt: timestamp("worker_last_seen_at", { withTimezone: true }),
});

export const metadataRunsTable = pgTable("metadata_runs", {
  id: uuid("id").primaryKey(),
  scopeKey: text("scope_key").notNull(),
  status: text("status").$type<"running" | "success" | "partial" | "failed">().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  totalFiles: integer("total_files").notNull().default(0),
  processedFiles: integer("processed_files").notNull().default(0),
  refreshedFiles: integer("refreshed_files").notNull().default(0),
  unchangedFiles: integer("unchanged_files").notNull().default(0),
  failedFiles: integer("failed_files").notNull().default(0),
  skippedFiles: integer("skipped_files").notNull().default(0),
  sampleLimit: integer("sample_limit"),
  error: text("error"),
}, table => [index("metadata_runs_scope_idx").on(table.scopeKey, table.startedAt)]);

export const metadataEventsTable = pgTable("metadata_events", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => metadataRunsTable.id, { onDelete: "cascade" }),
  driveId: text("drive_id").notNull(),
  itemId: text("item_id").notNull(),
  name: text("name").notNull(),
  status: text("status").$type<"refreshed" | "unchanged" | "failed" | "skipped">().notNull(),
  message: text("message").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("metadata_events_run_idx").on(table.runId, table.id)]);
