import { createHash } from "node:crypto";
import { metadataFields, type FileMetadata, ShufflrrError } from "@workspace/shufflrr";
import { AccessError } from "./sharepoint";
import { ProviderBackoffError } from "@workspace/shufflrr/http-policy";

export function metadataIntervalSeconds() {
  const value = process.env.METADATA_CRAWL_INTERVAL_SECONDS ?? "300";
  if (!/^\d+$/.test(value) || Number(value) < 30 || Number(value) > 86400)
    throw new Error("METADATA_CRAWL_INTERVAL_SECONDS must be between 30 and 86400.");
  return Number(value);
}
export function metadataFingerprint(fields: FileMetadata) {
  return createHash("sha256").update(JSON.stringify(
    metadataFields.filter(key => fields[key] !== undefined).map(key => [key, fields[key]]),
  )).digest("hex");
}
export function metadataIsDue(control: { requestedAt: Date | null; handledAt: Date | null; nextCrawlAt: Date;
  lastSyncFinishedAt: Date | null }, latestSync: Date | null, now = new Date()) {
  return control.nextCrawlAt <= now ||
    !!(control.requestedAt && (!control.handledAt || control.requestedAt > control.handledAt)) ||
    !!(latestSync && (!control.lastSyncFinishedAt || latestSync > control.lastSyncFinishedAt));
}
export function metadataCooldownActive(retryAt: Date | null | undefined, now = new Date()) {
  return !!retryAt && retryAt > now;
}
export function metadataCompletionUpdate(input: {
  processed: number; total: number; sample: boolean; providerRetryAt: Date | null;
  requestedAt: Date | null; latestSync: Date | null; intervalSeconds: number;
}, now = new Date()) {
  // A throttled final file is still unfinished work, even at total/total.
  // Omit handledAt so an explicit request remains pending until a real retry.
  if (input.providerRetryAt) return { retryAt: input.providerRetryAt, nextCrawlAt: input.providerRetryAt };
  if (input.sample || input.processed < input.total) return null;
  return { handledAt: input.requestedAt, lastSyncFinishedAt: input.latestSync,
    nextCrawlAt: new Date(now.getTime() + input.intervalSeconds * 1000), retryAt: null };
}
export function metadataSafeError(error: unknown): string {
  if (error instanceof ProviderBackoffError) return "The provider requested a cooldown; metadata will retry later.";
  if (error instanceof ShufflrrError) {
    if (error.code === "authentication") return "Shufflrr authentication failed. File sync is independent.";
    if (error.code === "configuration") return "Shufflrr configuration is incomplete.";
    if (error.code === "throttled") return "Shufflrr requested a cooldown; metadata will retry later.";
    if (error.code === "schema") return "Shufflrr returned invalid metadata; the previous snapshot was kept.";
    if (error.code === "permission") return "Shufflrr denied access to this metadata.";
    if (error.httpStatus === 404) return "The source file is no longer available; the previous snapshot was kept.";
  }
  if (error instanceof AccessError) return "The mapped SharePoint file could not be verified; the previous snapshot was kept.";
  return "Metadata could not be refreshed; the previous snapshot was kept. Check the metadata worker log.";
}
export function metadataRetryAt(error: unknown) {
  return error instanceof ShufflrrError || error instanceof ProviderBackoffError ? error.retryAt : undefined;
}
export async function isolatedMetadataRead<T>(read: () => Promise<T>): Promise<{ value: T } | { error: string; retryAt?: Date }> {
  try { return { value: await read() }; }
  catch (error) { return { error: metadataSafeError(error), retryAt: metadataRetryAt(error) }; }
}
