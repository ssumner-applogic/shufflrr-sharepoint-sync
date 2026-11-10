import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export interface SyncSourceFolder {
  id: number;
  name: string;
}

export interface SyncConflict {
  path: string;
  kind: "path-conflict" | "untracked-sharepoint-item";
}

export interface SyncRunSummary {
  createdFolders: number;
  copiedFiles: number;
  updatedFiles: number;
  deletedItems: number;
  conflicts: number;
}

export const syncConfigTable = pgTable("sync_config", {
  id: integer("id").primaryKey().default(1),
  destinationFolderId: text("destination_folder_id"),
  destinationFolderName: text("destination_folder_name"),
  sourceFolders: jsonb("source_folders").$type<SyncSourceFolder[]>().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastRunStatus: text("last_run_status"),
  lastRunSummary: jsonb("last_run_summary").$type<SyncRunSummary>(),
  lastRunConflicts: jsonb("last_run_conflicts").$type<SyncConflict[]>().notNull().default(sql`'[]'::jsonb`),
  lastRunError: text("last_run_error"),
});

export const syncItemsTable = pgTable("sync_items", {
  id: serial("id").primaryKey(),
  sourceRootId: text("source_root_id").notNull(),
  sourceRootName: text("source_root_name").notNull(),
  sourceId: text("source_id").notNull(),
  sourceIsFolder: boolean("source_is_folder").notNull(),
  sourceParentId: text("source_parent_id"),
  destinationRootId: text("destination_root_id").notNull(),
  destinationRootName: text("destination_root_name").notNull(),
  destinationId: text("destination_id").notNull(),
  relativePath: text("relative_path").notNull(),
  name: text("name").notNull(),
  sourceModifiedAt: text("source_modified_at"),
  sourceSize: integer("source_size").notNull().default(0),
  destinationCTag: text("destination_c_tag"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => [
  uniqueIndex("sync_items_scope_source_unique").on(
    table.sourceRootId, table.sourceId, table.sourceIsFolder, table.destinationRootId,
  ),
  index("sync_items_destination_root_idx").on(table.destinationRootId),
]);

export const syncOrphanNoticesTable = pgTable("sync_orphan_notices", {
  id: serial("id").primaryKey(),
  sourceRootId: text("source_root_id").notNull(),
  sourceRootName: text("source_root_name").notNull(),
  destinationFolderId: text("destination_folder_id").notNull(),
  destinationFolderName: text("destination_folder_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
}, table => [
  index("sync_orphan_notices_active_idx").on(table.dismissedAt, table.createdAt),
]);

export type SyncConfig = typeof syncConfigTable.$inferSelect;
export type SyncItem = typeof syncItemsTable.$inferSelect;
export type SyncOrphanNotice = typeof syncOrphanNoticesTable.$inferSelect;
