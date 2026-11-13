import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { syncConfigTable, syncItemsTable, syncFileRulesTable, type SyncConfig, type SyncItem } from "@workspace/db/schema";
import { excludedMappingIds } from "./sync-exclusions";
import { shufflrrConfig } from "./shufflrr";

export type MetadataDb = typeof import("@workspace/db")["db"];
export function metadataScopeKey(config: Pick<SyncConfig, "destinationFolderId" | "sourceFolders" | "excludedFolders">, sourcePortal: string) {
  return createHash("sha256").update(JSON.stringify([
    sourcePortal, config.destinationFolderId, config.sourceFolders.map(item => item.id).sort((a, b) => a - b),
    config.excludedFolders.map(item => `${item.rootId}:${item.id}`).sort(),
  ])).digest("hex");
}

export async function loadMetadataConfiguration(db: MetadataDb) {
  const [config] = await db.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1);
  if (!config?.destinationFolderId || !config.sourceFolders.length) return null;
  return { config: { ...config, destinationFolderId: config.destinationFolderId },
    key: metadataScopeKey(config, new URL(shufflrrConfig().baseUrl).origin) };
}
export async function loadMetadataScope(db: MetadataDb) {
  const scope = await loadMetadataConfiguration(db);
  if (!scope) return null;
  const { config } = scope;
  const mappings = await db.select().from(syncItemsTable).where(and(
    eq(syncItemsTable.destinationRootId, config.destinationFolderId),
    inArray(syncItemsTable.sourceRootId, config.sourceFolders.map(folder => String(folder.id))),
  )).orderBy(syncItemsTable.id).limit(100_001);
  const rules = await db.select().from(syncFileRulesTable).where(and(
    eq(syncFileRulesTable.destinationRootId, config.destinationFolderId), eq(syncFileRulesTable.action, "ignore"),
  )).limit(100_001);
  if (mappings.length > 100_000 || rules.length > 100_000) throw new Error("Metadata scope exceeded the safety limit.");
  const protectedIds = excludedMappingIds(mappings, config.excludedFolders);
  return {
    ...scope,
    mappings: mappings.filter(item => !item.sourceIsFolder && !protectedIds.has(item.id) &&
      !rules.some(rule => String(rule.sourceRootId) === item.sourceRootId && String(rule.sourceId) === item.sourceId)),
  };
}

export function sameMetadataBinding(expected: SyncItem, current: SyncItem) {
  return expected.id === current.id && expected.sourceId === current.sourceId &&
    expected.sourceRootId === current.sourceRootId && expected.destinationRootId === current.destinationRootId &&
    expected.destinationId === current.destinationId;
}

/** Validate only this binding after I/O rather than reloading the entire tree for every file. */
export async function metadataBindingStillActive(db: MetadataDb, scopeKey: string, mapping: SyncItem) {
  const [config] = await db.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1);
  if (!config?.destinationFolderId || metadataScopeKey(config, new URL(shufflrrConfig().baseUrl).origin) !== scopeKey) return false;
  const [current] = await db.select().from(syncItemsTable).where(eq(syncItemsTable.id, mapping.id)).limit(1);
  if (!current || !sameMetadataBinding(mapping, current)) return false;
  const [ignored] = await db.select({ id: syncFileRulesTable.id }).from(syncFileRulesTable).where(and(
    eq(syncFileRulesTable.destinationRootId, mapping.destinationRootId),
    eq(syncFileRulesTable.sourceRootId, Number(mapping.sourceRootId)),
    eq(syncFileRulesTable.sourceId, Number(mapping.sourceId)), eq(syncFileRulesTable.action, "ignore"),
  )).limit(1);
  return !ignored;
}
