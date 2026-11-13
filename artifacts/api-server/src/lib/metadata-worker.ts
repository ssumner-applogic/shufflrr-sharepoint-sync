import { randomUUID } from "node:crypto";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { metadataControlTable, metadataRunsTable, metadataEventsTable, syncRunsTable, syncRunEventsTable } from "@workspace/db/schema";
import { newShufflrrClient, shufflrrConfig } from "./shufflrr";
import { getSyncDriveItem, syncDriveId } from "./sharepoint";
import { logger as baseLogger } from "./logger";
import { isolatedMetadataRead, metadataIntervalSeconds, metadataIsDue, metadataSafeError, metadataRetryAt, metadataCooldownActive, metadataCompletionUpdate } from "./metadata-policy";
import { loadMetadataScope, metadataBindingStillActive } from "./metadata-scope";
import { metadataBinding, saveMetadataObservation } from "./metadata-store";

// A different transaction-scoped lock from the file-transfer lock. Crashes release
// the claim automatically, including through Neon's transaction-pooled endpoint.
export const METADATA_LOCK_ID = 74120938;
const logger = baseLogger.child({ service: "metadata-worker", environment: process.env.NODE_ENV ?? "unspecified" });

export async function runMetadataCycle(options: { force?: boolean; limit?: number; shouldStop?: () => boolean } = {}) {
  const interval = metadataIntervalSeconds();
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10))
    throw new Error("Metadata validation limit must be between 1 and 10.");
  const { db, pool } = await import("@workspace/db");
  const connection = await pool.connect();
  const runId = randomUUID();
  let started = false;
  let claimRequestAt: Date | null = null;
  let latestSync: Date | null = null;
  let providerRetryAt: Date | null = null;
  let client: ReturnType<typeof newShufflrrClient> | undefined;
  const counts = { totalFiles: 0, processedFiles: 0, refreshedFiles: 0, unchangedFiles: 0, failedFiles: 0, skippedFiles: 0 };
  try {
    await connection.query("BEGIN");
    const claim = await connection.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [METADATA_LOCK_ID]);
    if (!claim.rows[0]?.locked) return { skipped: true };
    const [control] = await db.insert(metadataControlTable).values({ id: 1, workerLastSeenAt: new Date() })
      .onConflictDoUpdate({ target: metadataControlTable.id, set: { workerLastSeenAt: new Date() } }).returning();
    // We own the lock: a running journal left behind cannot still have a live owner.
    const interruptionMessage = "Metadata worker stopped before completion. The next refresh will retry; file sync was not affected.";
    await db.update(metadataRunsTable).set({ status: "failed", finishedAt: new Date(), error: interruptionMessage })
      .where(eq(metadataRunsTable.status, "running"));
    const scope = await loadMetadataScope(db);
    if (!scope) return { skipped: true };
    if (metadataCooldownActive(control!.retryAt)) return { skipped: true };
    const [latestRun] = await db.select({ finishedAt: syncRunsTable.finishedAt }).from(syncRunsTable)
      .where(sql`${syncRunsTable.finishedAt} is not null and (
        coalesce((${syncRunsTable.summary}->>'copiedFiles')::integer, 0) > 0 or
        coalesce((${syncRunsTable.summary}->>'updatedFiles')::integer, 0) > 0 or
        coalesce((${syncRunsTable.summary}->>'deletedItems')::integer, 0) > 0 or
        exists (select 1 from ${syncRunEventsTable} where ${syncRunEventsTable.runId} = ${syncRunsTable.id}
          and ${syncRunEventsTable.status} = 'moved')
      )`).orderBy(desc(syncRunsTable.finishedAt)).limit(1);
    latestSync = latestRun?.finishedAt ?? null;
    if (!options.force && !metadataIsDue(control!, latestSync)) return { skipped: true };
    // Metadata is lower priority. Wait for a running file job to finish before starting a crawl.
    if (scope.config.lastRunStatus === "running" && !options.force) return { skipped: true };
    claimRequestAt = control!.requestedAt;
    const mappings = options.limit ? scope.mappings.slice(0, options.limit) : scope.mappings;
    if (mappings.length > 100_000) throw new Error("Metadata scope exceeded the safety limit.");
    counts.totalFiles = mappings.length;
    await db.insert(metadataRunsTable).values({
      id: runId, scopeKey: scope.key, status: "running", totalFiles: mappings.length, sampleLimit: options.limit ?? null,
    });
    started = true;
    logger.info({ event: "metadata_run_started", requestId: runId, totalFiles: mappings.length }, "Metadata refresh started.");
    const credentials = shufflrrConfig();
    const sourcePortal = new URL(credentials.baseUrl).origin;
    let driveId: string;
    driveId = await syncDriveId();
    client = newShufflrrClient();
    await client.login(credentials.email, credentials.password);
    for (const mapping of mappings) {
      if (options.shouldStop?.()) break;
      const outcome = await isolatedMetadataRead(async () => {
        const destination = await getSyncDriveItem(mapping.destinationId);
        if (destination.isFolder) throw new Error("Invalid file binding.");
        return client!.fileMetadata(Number(mapping.sourceId));
      });
      // Recheck scope and exact persisted binding after provider I/O. Queued work is
      // not permission to operate on a removed, excluded, ignored or remapped file.
      const stillMapped = await metadataBindingStillActive(db, scope.key, mapping);
      const status = stillMapped
        ? await saveMetadataObservation(db, metadataBinding(driveId, sourcePortal, mapping), outcome)
        : "skipped";
      counts.processedFiles++;
      if (status === "refreshed") counts.refreshedFiles++;
      else if (status === "unchanged") counts.unchangedFiles++;
      else if (status === "failed") counts.failedFiles++;
      else counts.skippedFiles++;
      const message = status === "skipped" ? "Mapping changed, was ignored, excluded or disconnected; no snapshot was replaced."
        : "error" in outcome ? outcome.error
        : status === "unchanged" ? "Allowlisted metadata checked; no change." : "Allowlisted source metadata saved in Neon. No SharePoint fields changed.";
      await db.insert(metadataEventsTable).values({ runId, driveId, itemId: mapping.destinationId, name: mapping.name, status, message });
      await db.update(metadataRunsTable).set(counts).where(eq(metadataRunsTable.id, runId));
      await db.update(metadataControlTable).set({ workerLastSeenAt: new Date() }).where(eq(metadataControlTable.id, 1));
      if ("error" in outcome && outcome.retryAt) {
        providerRetryAt = outcome.retryAt;
        await db.update(metadataControlTable).set({ retryAt: outcome.retryAt }).where(eq(metadataControlTable.id, 1));
        break;
      }
    }
    const interrupted = counts.processedFiles < counts.totalFiles;
    const status = counts.failedFiles || counts.skippedFiles || interrupted ? "partial" as const : "success" as const;
    await db.update(metadataRunsTable).set({ ...counts, status, finishedAt: new Date() }).where(eq(metadataRunsTable.id, runId));
    const completionUpdate = metadataCompletionUpdate({ processed: counts.processedFiles, total: counts.totalFiles,
      sample: options.limit !== undefined, providerRetryAt, requestedAt: claimRequestAt, latestSync, intervalSeconds: interval });
    if (completionUpdate) await db.update(metadataControlTable).set(completionUpdate).where(eq(metadataControlTable.id, 1));
    // Prune only our own journals, never snapshots, mappings or file-sync activity.
    const keep = await db.select({ id: metadataRunsTable.id }).from(metadataRunsTable)
      .orderBy(desc(metadataRunsTable.startedAt)).limit(50);
    if (keep.length) await db.delete(metadataRunsTable).where(notInArray(metadataRunsTable.id, keep.map(row => row.id)));
    logger.info({ event: "metadata_run_finished", requestId: runId, status, ...counts }, "Metadata refresh finished.");
    return { skipped: false, status, ...counts };
  } catch (error) {
    const message = metadataSafeError(error);
    logger.error({ event: "metadata_run_failed", requestId: runId }, "Metadata refresh failed; file sync is independent.");
    if (started) await db.update(metadataRunsTable).set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(metadataRunsTable.id, runId)).catch(() => {});
    // Failure cooldown prevents a failing provider or database from spinning.
    const cooldown = metadataRetryAt(error);
    await db.update(metadataControlTable).set({ nextCrawlAt: cooldown ?? new Date(Date.now() + interval * 1000),
      retryAt: cooldown ?? new Date(Date.now() + interval * 1000),
      ...(cooldown ? {} : { handledAt: claimRequestAt, lastSyncFinishedAt: latestSync }),
    }).where(eq(metadataControlTable.id, 1)).catch(() => {});
    throw new Error(message);
  } finally {
    await client?.close().catch(() => {});
    try { await connection.query("ROLLBACK"); connection.release(); }
    catch { connection.release(new Error("Metadata claim cleanup failed.")); }
  }
}
