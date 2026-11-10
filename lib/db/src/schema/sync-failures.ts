import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
export interface SyncFileReference {
  id: number; rootId: number; parentId: number; name: string;
  ancestorIds: number[]; modifiedAt?: string; size?: number;
  fileHistoryId?: number;
}
export const syncFileFailuresTable = pgTable("sync_file_failures", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull(),
  sourceRootId: integer("source_root_id").notNull(),
  parentId: integer("parent_id").notNull(),
  fileHistoryId: integer("file_history_id"),
  ancestorIds: jsonb("ancestor_ids").$type<number[]>().notNull(),
  destinationRootId: text("destination_root_id").notNull(),
  portalOrigin: text("portal_origin").notNull(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  reason: text("reason").notNull(),
  fingerprint: text("fingerprint").notNull(),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }).notNull().defaultNow(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  retryRequestedAt: timestamp("retry_requested_at", { withTimezone: true }),
}, table => [
  uniqueIndex("sync_file_failure_scope_idx").on(table.sourceId, table.sourceRootId, table.destinationRootId),
  index("sync_file_failure_pending_idx").on(table.resolvedAt, table.retryRequestedAt),
  index("sync_file_failure_destination_idx").on(table.destinationRootId, table.resolvedAt),
]);
