import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { syncFileFailuresTable } from "./sync-failures";
import { syncRunsTable } from "./sync-log";

export type SyncFileIssueStatus = "failed" | "conflict" | "skipped";

export const syncFileFailureIssuesTable = pgTable("sync_file_failure_issues", {
  id: serial("id").primaryKey(),
  failureId: integer("failure_id").notNull().references(() => syncFileFailuresTable.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => syncRunsTable.id, { onDelete: "cascade" }),
  status: text("status").$type<SyncFileIssueStatus>().notNull(),
  reason: text("reason").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("sync_file_failure_issue_history_idx").on(table.failureId, table.occurredAt, table.id),
  index("sync_file_failure_issue_run_idx").on(table.runId),
]);
