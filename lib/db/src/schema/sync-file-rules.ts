import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { syncFileFailuresTable } from "./sync-failures";

export const syncFileRulesTable = pgTable("sync_file_rules", {
  id: serial("id").primaryKey(),
  failureId: integer("failure_id").notNull().references(() => syncFileFailuresTable.id),
  sourceId: integer("source_id").notNull(),
  sourceRootId: integer("source_root_id").notNull(),
  destinationRootId: text("destination_root_id").notNull(),
  destinationRootName: text("destination_root_name").notNull(),
  action: text("action").$type<"ignore" | "overwrite">().notNull(),
  expectedDestinationId: text("expected_destination_id"),
  expectedETag: text("expected_etag"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("sync_file_rules_scope_idx").on(table.sourceId, table.sourceRootId, table.destinationRootId)]);
export type SyncFileRule = typeof syncFileRulesTable.$inferSelect;
