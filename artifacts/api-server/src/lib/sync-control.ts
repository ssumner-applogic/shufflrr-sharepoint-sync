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

/** Explicit one-file retries remain permitted while automatic sync is paused. */
export function syncPauseCheckpoint(db: Database, targetedRetry: boolean) {
  return async () => {
    if (targetedRetry) return;
    const [config] = await db.select({ enabled: syncConfigTable.enabled }).from(syncConfigTable)
      .where(eq(syncConfigTable.id, 1)).limit(1);
    if (!config?.enabled) throw new SyncPauseRequested();
  };
}
