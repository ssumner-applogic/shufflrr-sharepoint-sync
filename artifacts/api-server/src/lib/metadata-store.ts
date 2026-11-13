import { and, eq, sql } from "drizzle-orm";
import { fileMetadataTable, metadataControlTable, type SyncItem } from "@workspace/db/schema";
import type { FileMetadata } from "@workspace/shufflrr";
import { metadataFingerprint } from "./metadata-policy";
import type { MetadataDb } from "./metadata-scope";

export async function requestMetadataRefresh(db: MetadataDb) {
  const [control] = await db.insert(metadataControlTable).values({ id: 1, requestedAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({ target: metadataControlTable.id, set: { requestedAt: sql`clock_timestamp()` } }).returning();
  return control!.requestedAt!;
}
export function metadataBinding(driveId: string, sourcePortal: string, mapping: SyncItem) {
  return { driveId, itemId: mapping.destinationId, sourcePortal, sourceFileId: Number(mapping.sourceId),
    sourceRootId: mapping.sourceRootId, destinationRootId: mapping.destinationRootId };
}
export function metadataObservationPatch(outcome: { value: FileMetadata } | { error: string }, previousFingerprint: string | null, now = new Date()) {
  if ("error" in outcome) return { lastError: outcome.error, lastAttemptAt: now, status: "failed" as const };
  const fingerprint = metadataFingerprint(outcome.value);
  return {
    fields: outcome.value, fingerprint, observedAt: now, lastError: null, lastAttemptAt: now,
    status: previousFingerprint === fingerprint ? "unchanged" as const : "refreshed" as const,
  };
}
export async function saveMetadataObservation(db: MetadataDb, binding: ReturnType<typeof metadataBinding>,
  outcome: { value: FileMetadata } | { error: string }) {
  const where = and(eq(fileMetadataTable.driveId, binding.driveId), eq(fileMetadataTable.itemId, binding.itemId),
    eq(fileMetadataTable.sourcePortal, binding.sourcePortal), eq(fileMetadataTable.sourceFileId, binding.sourceFileId));
  const [previous] = await db.select().from(fileMetadataTable).where(where).limit(1);
  const { status, ...data } = metadataObservationPatch(outcome, previous?.fingerprint ?? null);
  await db.insert(fileMetadataTable).values({ ...binding, ...data })
    .onConflictDoUpdate({
      target: [fileMetadataTable.driveId, fileMetadataTable.itemId, fileMetadataTable.sourcePortal, fileMetadataTable.sourceFileId],
      // Failure intentionally never changes fields, fingerprint, or observedAt.
      set: { ...binding, ...data },
    });
  return status;
}
