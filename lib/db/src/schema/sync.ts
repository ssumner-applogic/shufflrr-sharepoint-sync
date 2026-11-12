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

export interface SyncFolderExclusion extends SyncSourceFolder {
  rootId: number;
  /** Root-to-parent chain, including rootId but not this folder's own ID. */
  ancestorIds: number[];
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
  fileProgress?: SyncRunFileProgress;
  /** Aggregate of a complete in-scope source/destination scan; no provider credentials. */
  inventory?: SyncInventorySnapshot;
}

export interface SyncRunFileProgress {
  totalFiles: number;
  processedFiles: number;
}

export interface SyncInventorySnapshot {
  scopeKey: string;
  scannedAt: string;
  sourceFiles: number;
  sourceBytes: number;
  sourceUnknownSizeFiles: number;
  synchronizedFiles: number;
  synchronizedBytes: number;
  failedFiles: number;
  pendingFiles: number;
  notSynchronizedFiles: number;
}

export const syncConfigTable = pgTable("sync_config", {
  id: integer("id").primaryKey().default(1),
  destinationFolderId: text("destination_folder_id"),
  destinationFolderName: text("destination_folder_name"),
  sourceFolders: jsonb("source_folders").$type<SyncSourceFolder[]>().notNull().default(sql`'[]'::jsonb`),
  excludedFolders: jsonb("excluded_folders").$type<SyncFolderExclusion[]>().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean("enabled").notNull().default(false),
  pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(60),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  providerRetryAt: timestamp("provider_retry_at", { withTimezone: true }),
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

// Delta links are server-only continuation credentials; never serialize these through an API.
export const syncSharepointStateTable = pgTable("sync_sharepoint_state", {
  driveId: text("drive_id").primaryKey(),
  deltaLink: text("delta_link").notNull(),
});

export const syncSharepointItemsTable = pgTable("sync_sharepoint_items", {
  driveId: text("drive_id").notNull(),
  itemId: text("item_id").notNull(),
  item: jsonb("item").$type<{
    id: string; name: string; isFolder: boolean; size: number;
    modifiedAt: string; parentId?: string; cTag?: string;
  }>().notNull(),
}, table => [
  uniqueIndex("sync_sharepoint_snapshot_unique").on(table.driveId, table.itemId),
]);
