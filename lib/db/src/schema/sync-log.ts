import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { SyncRunSummary } from "./sync";
import type { SyncFileReference } from "./sync-failures";

export type SyncEventStatus = "created" | "copied" | "updated" | "moved" | "deleted" | "unchanged" | "conflict" | "failed" | "skipped";
export const syncRunsTable = pgTable("sync_runs", {
  id: text("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  summary: jsonb("summary").$type<SyncRunSummary>(),
  error: text("error"),
}, table => [index("sync_runs_started_idx").on(table.startedAt)]);

export const syncRunEventsTable = pgTable("sync_run_events", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull().references(() => syncRunsTable.id, { onDelete: "cascade" }),
  status: text("status").$type<SyncEventStatus>().notNull(),
  path: text("path"),
  destinationPath: text("destination_path"),
  itemType: text("item_type").$type<"file" | "folder" | "run">().notNull(),
  message: text("message").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("sync_run_events_page_idx").on(table.runId, table.status, table.id),
  index("sync_run_events_run_idx").on(table.runId, table.id)]);

export type SyncLogEventInput = Pick<typeof syncRunEventsTable.$inferInsert, "status" | "path" | "destinationPath" | "itemType" | "message">
  & { sourceFile?: SyncFileReference };
