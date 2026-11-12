import { eq, isNotNull, isNull, and } from "drizzle-orm";
import { syncFileFailuresTable, type syncConfigTable, type SyncFileRule } from "@workspace/db/schema";

type Database = typeof import("@workspace/db")["db"];

/** The run lock is already held: drain the queued group, not one file per run. */
export async function loadQueuedSyncRetries(
  db: Database,
  config: typeof syncConfigTable.$inferSelect | undefined,
  fileRules: SyncFileRule[],
) {
  const queued = await db.select().from(syncFileFailuresTable).where(and(
    isNull(syncFileFailuresTable.resolvedAt), isNotNull(syncFileFailuresTable.retryRequestedAt),
  )).orderBy(syncFileFailuresTable.id);
  const retries: typeof queued = [];
  for (const row of queued) {
    const valid = config?.destinationFolderId === row.destinationRootId &&
      !fileRules.some(rule => rule.action === "ignore" && rule.sourceRootId === row.sourceRootId && rule.sourceId === row.sourceId) &&
      config.sourceFolders.some(folder => folder.id === row.sourceRootId) &&
      !config.excludedFolders.some(folder => folder.rootId === row.sourceRootId && row.ancestorIds.includes(folder.id));
    if (valid) {
      retries.push(row);
      if (row.dismissedAt) await db.update(syncFileFailuresTable)
        .set({ dismissedAt: null }).where(eq(syncFileFailuresTable.id, row.id));
    } else await db.update(syncFileFailuresTable).set({
      retryRequestedAt: null,
      reason: "The sync scope changed. This file was not retried; adjust the selection or dismiss this notice.",
    }).where(eq(syncFileFailuresTable.id, row.id));
  }
  return retries;
}
