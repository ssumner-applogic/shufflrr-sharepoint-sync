import { test } from "node:test";
import assert from "node:assert/strict";
import { metadataFields, parseFileMetadata } from "@workspace/shufflrr";
import { ProviderBackoffError } from "@workspace/shufflrr/http-policy";
import { metadataCooldownActive, metadataFingerprint, metadataIsDue, isolatedMetadataRead, metadataCompletionUpdate, metadataIntervalSeconds } from "./metadata-policy";
import { SetMetadataIntervalBody } from "@workspace/api-zod";
import { metadataObservationPatch } from "./metadata-store";
import { metadataScopeKey } from "./metadata-scope";

// In-memory values only: no provider files or persistent test mappings are created.
const minimum = { id: 1, name: "existing.pptx" };

test("metadata intervals accept exactly the four UI options and reject invalid input", () => {
  for (const intervalSeconds of [300, 600, 900, 3600]) {
    assert.equal(metadataIntervalSeconds(intervalSeconds), intervalSeconds);
    assert.ok(SetMetadataIntervalBody.safeParse({ intervalSeconds }).success);
  }
  for (const intervalSeconds of [0, -1, 60, 301, 86400, 1.5, "300", null, undefined]) {
    assert.equal(SetMetadataIntervalBody.safeParse({ intervalSeconds }).success, false);
    if (typeof intervalSeconds === "number") assert.throws(() => metadataIntervalSeconds(intervalSeconds));
  }
});

test("captures exactly the requested 21 fields and drops everything else", () => {
  assert.equal(metadataFields.length, 21);
  const parsed = parseFileMetadata({ ...minimum, author: null, size: 100,
    tags: ["excluded"], slides: [{ content: "excluded" }], expiryDate: "excluded", raw: "excluded" }, 1);
  assert.deepEqual(parsed, { ...minimum, author: null, size: 100 });
  assert.ok(!Object.hasOwn(parsed, "description"));
  assert.ok(Object.hasOwn(parsed, "author"));
});

test("keeps activity dates and original-file dates separate and unchanged", () => {
  const dates = {
    createdDate: "2026-01-01T10:00:00-05:00", modifiedDate: "2026-01-02T10:00:00Z",
    fileCreatedDate: "2025-01-01T10:00:00Z", fileModifiedDate: null,
  };
  assert.deepEqual(parseFileMetadata({ ...minimum, ...dates }, 1), { ...minimum, ...dates });
});

test("rejects mismatched identity and invalid numeric, text or date data", () => {
  for (const invalid of [
    { ...minimum, id: 2 }, { ...minimum, name: null }, { ...minimum, size: -1 },
    { ...minimum, size: Number.MAX_SAFE_INTEGER + 1 }, { ...minimum, author: {} },
    { ...minimum, modifiedDate: "not-a-date" },
  ]) assert.throws(() => parseFileMetadata(invalid, 1));
});

test("detects metadata-only edits without requiring a changed name or binary size", () => {
  const original = parseFileMetadata({ ...minimum, size: 100, description: "Before" }, 1);
  const changed = parseFileMetadata({ ...original, description: "After" }, 1);
  assert.notEqual(metadataFingerprint(original), metadataFingerprint(changed));
  assert.notEqual(metadataFingerprint(minimum), metadataFingerprint({ ...minimum, author: null }));
  assert.equal(metadataFingerprint(original), metadataFingerprint({ size: 100, description: "Before", ...minimum }));
});

test("an individual metadata failure is safe and does not prevent the next read", async () => {
  const failed = await isolatedMetadataRead(async () => { throw new Error("sensitive-provider-detail"); });
  assert.ok("error" in failed);
  assert.ok(!JSON.stringify(failed).includes("sensitive-provider-detail"));
  assert.deepEqual(await isolatedMetadataRead(async () => minimum), { value: minimum });
});

test("failure patches preserve the last good fields, fingerprint and observation time", () => {
  const patch = metadataObservationPatch({ error: "Safe failure" }, "previous");
  for (const key of ["fields", "fingerprint", "observedAt"]) assert.ok(!Object.hasOwn(patch, key));
  assert.equal(patch.status, "failed");
  const good = metadataObservationPatch({ value: minimum }, null);
  assert.equal(good.status, "refreshed");
  assert.equal(metadataObservationPatch({ value: minimum }, metadataFingerprint(minimum)).status, "unchanged");
});

test("scheduled crawls, completed file changes and coalesced manual requests become due", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const prior = new Date(now.getTime() - 1000);
  const future = new Date(now.getTime() + 1000);
  const control = { requestedAt: prior, handledAt: prior, nextCrawlAt: future, lastSyncFinishedAt: prior };
  assert.equal(metadataIsDue(control, prior, now), false);
  assert.equal(metadataIsDue({ ...control, nextCrawlAt: prior }, prior, now), true);
  assert.equal(metadataIsDue({ ...control, requestedAt: now }, prior, now), true);
  assert.equal(metadataIsDue(control, now, now), true);
  // Completion handles only the captured timestamp; a request arriving during a run remains due.
  assert.equal(metadataIsDue({ ...control, requestedAt: now, handledAt: prior }, prior, now), true);
});

test("provider cooldown is preserved and cannot be bypassed by new work", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const retryAt = new Date(now.getTime() + 60_000);
  const result = await isolatedMetadataRead(async () => { throw new ProviderBackoffError("Shufflrr", retryAt); });
  assert.ok("error" in result);
  assert.deepEqual(result.retryAt, retryAt);
  assert.equal(metadataCooldownActive(retryAt, now), true);
  assert.equal(metadataCooldownActive(retryAt, retryAt), false);
});

test("throttling the only file or final file preserves cooldown and leaves the request pending", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const retryAt = new Date(now.getTime() + 60_000);
  const requestedAt = new Date(now.getTime() - 1000);
  for (const total of [1, 10]) {
    const patch = metadataCompletionUpdate({ processed: total, total, sample: false,
      providerRetryAt: retryAt, requestedAt, latestSync: null, intervalSeconds: 300 }, now);
    assert.deepEqual(patch, { retryAt, nextCrawlAt: retryAt });
    assert.ok(patch);
    assert.ok(!Object.hasOwn(patch!, "handledAt"));
    const control = { requestedAt, handledAt: null, lastSyncFinishedAt: null, nextCrawlAt: patch.nextCrawlAt };
    assert.equal(metadataIsDue(control, null, now), true);
    assert.equal(metadataCooldownActive(patch!.retryAt, now), true);
  }
  const success = metadataCompletionUpdate({ processed: 1, total: 1, sample: false,
    providerRetryAt: null, requestedAt, latestSync: now, intervalSeconds: 300 }, now);
  assert.equal(success?.handledAt, requestedAt);
  assert.equal(success.retryAt, null);
});

test("scope identity changes on disconnect, remap or folder exclusion, not selection order", () => {
  const a = { destinationFolderId: "destination", sourceFolders: [{ id: 1, name: "a" }, { id: 2, name: "b" }], excludedFolders: [] };
  assert.equal(metadataScopeKey(a, "provider-a"), metadataScopeKey({ ...a, sourceFolders: [...a.sourceFolders].reverse() }, "provider-a"));
  assert.notEqual(metadataScopeKey(a, "provider-a"), metadataScopeKey({ ...a, destinationFolderId: null }, "provider-a"));
  assert.notEqual(metadataScopeKey(a, "provider-a"), metadataScopeKey({ ...a, excludedFolders: [{ id: 3, rootId: 1, name: "excluded", ancestorIds: [] }] }, "provider-a"));
  assert.notEqual(metadataScopeKey(a, "provider-a"), metadataScopeKey(a, "provider-b"));
});
