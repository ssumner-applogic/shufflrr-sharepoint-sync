import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { syncConfigTable, syncFileFailuresTable, syncItemsTable, syncOrphanNoticesTable } from "@workspace/db/schema";
import { AccessError } from "./sharepoint";

type Database = typeof import("@workspace/db")["db"];

export class SyncPauseRequested extends Error {}

/** Detach only the configuration; retained IDs allow the same pair to resume later. */
export async function disconnectSyncFolders(db: Database, syncLockId: number): Promise<void> {
  await db.transaction(async tx => {
    // Serialize with both full runs and explicit retries, even when automatic sync is paused.
    const lockResult = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${syncLockId}) AS locked`);
    if ((lockResult.rows[0] as { locked?: boolean } | undefined)?.locked !== true)
      throw new AccessError("SyncRunning", "Wait for the current sync run to finish before disconnecting its folders.", 409);

    // Serialize with Start and Save; a concurrent Start must see the cleared configuration.
    const [config] = await tx.select().from(syncConfigTable)
      .where(eq(syncConfigTable.id, 1)).limit(1).for("update");
    if (!config) return;
    if (config.enabled)
      throw new AccessError("SyncEnabled", "Pause sync before disconnecting its folders.", 409);
    if (config.lastRunStatus === "running")
      throw new AccessError("SyncRunning", "Wait for the current sync run to finish before disconnecting its folders.", 409);

    if (config.destinationFolderId && config.sourceFolders.length) {
      const mappedRoots = await tx.select({ sourceRootId: syncItemsTable.sourceRootId }).from(syncItemsTable).where(and(
        eq(syncItemsTable.destinationRootId, config.destinationFolderId),
        inArray(syncItemsTable.sourceRootId, config.sourceFolders.map(folder => String(folder.id))),
        eq(syncItemsTable.sourceIsFolder, true),
        isNull(syncItemsTable.sourceParentId),
      ));
      const existingNotices = await tx.select({ sourceRootId: syncOrphanNoticesTable.sourceRootId })
        .from(syncOrphanNoticesTable).where(and(
          eq(syncOrphanNoticesTable.destinationFolderId, config.destinationFolderId),
          isNull(syncOrphanNoticesTable.dismissedAt),
        ));
      const mappedIds = new Set(mappedRoots.map(root => root.sourceRootId));
      const noticeIds = new Set(existingNotices.map(notice => notice.sourceRootId));
      const detached = config.sourceFolders.filter(folder =>
        mappedIds.has(String(folder.id)) && !noticeIds.has(String(folder.id)));
      if (detached.length) await tx.insert(syncOrphanNoticesTable).values(detached.map(folder => ({
        sourceRootId: String(folder.id),
        sourceRootName: folder.name,
        destinationFolderId: config.destinationFolderId!,
        destinationFolderName: config.destinationFolderName ?? "SharePoint sync folder",
      })));
      // Retain notices, but cancel queued work so reconnecting this pair while
      // paused cannot accidentally revive a pre-disconnect explicit retry.
      await tx.update(syncFileFailuresTable).set({ retryRequestedAt: null }).where(and(
        eq(syncFileFailuresTable.destinationRootId, config.destinationFolderId),
        inArray(syncFileFailuresTable.sourceRootId, config.sourceFolders.map(folder => folder.id)),
        isNotNull(syncFileFailuresTable.retryRequestedAt),
      ));
    }

    // Do not touch provider content, file mappings, failure notices, run history,
    // polling preferences, or provider cooldowns.
    await tx.update(syncConfigTable).set({
      destinationFolderId: null,
      destinationFolderName: null,
      sourceFolders: [],
      excludedFolders: [],
      enabled: false,
      nextRunAt: null,
      updatedAt: new Date(),
    }).where(eq(syncConfigTable.id, 1));
  });
}

/** Control changes must not wait for the worker's whole-run advisory lock. */
export async function setSyncEnabledState(db: Database, enabled: boolean) {
  await db.transaction(async tx => {
    const [config] = await tx.select().from(syncConfigTable)
      .where(eq(syncConfigTable.id, 1)).limit(1).for("update");
    if (enabled && (!config?.destinationFolderId || !config.sourceFolders.length))
      throw new AccessError("SyncNotConfigured", "Save a SharePoint destination and Shufflrr folders before starting sync.", 400);
    await tx.insert(syncConfigTable).values({ id: 1, enabled })
      .onConflictDoUpdate({ target: syncConfigTable.id, set: {
        enabled,
        nextRunAt: enabled && !config?.enabled
          ? sql`greatest(now(), coalesce(${syncConfigTable.providerRetryAt}, now()))`
          : config?.nextRunAt ?? null,
        updatedAt: new Date(),
      } });
  });
}

/** Request an immediate full run without changing the saved polling interval. */
export async function requestSyncNow(db: Database, syncLockId: number): Promise<void> {
  await db.transaction(async tx => {
    const lockResult = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${syncLockId}) AS locked`);
    const locked = (lockResult.rows[0] as { locked?: boolean } | undefined)?.locked === true;
    if (!locked) throw new AccessError("SyncRunning", "Wait for the current sync run to finish before requesting another.", 409);

    const [config] = await tx.select({
      enabled: syncConfigTable.enabled,
      destinationFolderId: syncConfigTable.destinationFolderId,
      sourceFolders: syncConfigTable.sourceFolders,
    }).from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1).for("update");
    if (!config?.destinationFolderId || !config.sourceFolders.length)
      throw new AccessError("SyncNotConfigured", "Save a SharePoint destination and Shufflrr folders before syncing.", 400);
    if (!config.enabled)
      throw new AccessError("SyncPaused", "Start sync before requesting an immediate run.", 409);

    await tx.update(syncConfigTable).set({
      nextRunAt: sql`greatest(now(), coalesce(${syncConfigTable.providerRetryAt}, now()))`,
      updatedAt: new Date(),
    }).where(eq(syncConfigTable.id, 1));
  });
}

/** Explicit one-file retries remain permitted while automatic sync is paused. */
export function syncPauseCheckpoint(db: Database, targetedRetry: boolean) {
  return async () => {
    if (targetedRetry) return;
    const [config] = await db.select({ enabled: syncConfigTable.enabled }).from(syncConfigTable)
      .where(eq(syncConfigTable.id, 1)).limit(1);
    if (!config?.enabled) throw new SyncPauseRequested();
  };
}
