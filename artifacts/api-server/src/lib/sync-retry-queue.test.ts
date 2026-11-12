import assert from "node:assert/strict";
import test from "node:test";
import { loadQueuedSyncRetries } from "./sync-retry-queue";
import { SyncRunJournal } from "./sync-log";
import type { syncConfigTable, syncFileFailuresTable, SyncFileRule } from "@workspace/db/schema";

type Failure = typeof syncFileFailuresTable.$inferSelect;
type Database = typeof import("@workspace/db")["db"];
const config = {
  destinationFolderId: "target", sourceFolders: [{ id: 1, name: "Source" }], excludedFolders: [],
} as unknown as typeof syncConfigTable.$inferSelect;
function failure(id: number): Failure {
  return { id, sourceId: id, sourceRootId: 1, parentId: 1, fileHistoryId: null, ancestorIds: [1],
    destinationRootId: "target", portalOrigin: "https://example.invalid", name: `file-${id}.pdf`,
    path: `Source/file-${id}.pdf`, reason: "Test conflict", fingerprint: "test",
    lastFailedAt: new Date(0), dismissedAt: new Date(0), resolvedAt: null, retryRequestedAt: new Date(0) };
}
function queueDb(rows: Failure[]) {
  const updates: Array<Record<string, unknown>> = [];
  return { updates, db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => rows }) }) }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updates.push(values); } }) }),
  } as unknown as Database };
}
test("all three queued files are returned together for a single run", async () => {
  const f = queueDb([failure(1), failure(2), failure(3)]);
  const group = await loadQueuedSyncRetries(f.db, config, []);
  assert.deepEqual(group.map(row => row.id), [1, 2, 3]);
  assert.equal(f.updates.length, 3);
  assert.ok(f.updates.every(update => update.dismissedAt === null && !("retryRequestedAt" in update)));
});
test("invalid-scope and ignored requests are cancelled without discarding valid group members", async () => {
  const rows = [failure(1), { ...failure(2), destinationRootId: "other-target" }, failure(3),
    { ...failure(4), ancestorIds: [1, 99] }];
  const f = queueDb(rows);
  const ignored = { action: "ignore", sourceRootId: 1, sourceId: 3 } as SyncFileRule;
  const group = await loadQueuedSyncRetries(f.db, {
    ...config, excludedFolders: [{ rootId: 1, id: 99, name: "Excluded", ancestorIds: [1] }],
  }, [ignored]);
  assert.deepEqual(group.map(row => row.id), [1]);
  assert.equal(f.updates.filter(update => update.retryRequestedAt === null).length, 3);
});
test("a grouped retry advertises its identity and zero-of-three progress before discovery", () => {
  const journal = new SyncRunJournal({} as Database, "test-run", 3);
  assert.equal(journal.summary?.runKind, "retry");
  assert.deepEqual(journal.summary?.fileProgress, { totalFiles: 3, processedFiles: 0 });
  assert.equal(new SyncRunJournal({} as Database, "full-run").summary?.runKind, "full");
});
