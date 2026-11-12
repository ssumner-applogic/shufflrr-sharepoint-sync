import { eq, sql } from "drizzle-orm";
import { syncConfigTable } from "@workspace/db/schema";
import { AccessError } from "./sharepoint";

type Database = typeof import("@workspace/db")["db"];

export class SyncPauseRequested extends Error {}

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
