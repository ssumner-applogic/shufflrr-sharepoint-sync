import { test } from "node:test";
import assert from "node:assert/strict";
import type { SyncFileRule, SyncItem, SyncRunSummary } from "@workspace/db/schema";
import { SyncInventory, syncInventoryScopeKey } from "./sync-inventory";
import { SyncRunJournal } from "./sync-log";

const root = { id: 1, name: "Source" };
const scope = { destinationFolderId: "destination", sourceFolders: [root] };
const source = (id: number, size?: number) => ({
  root, entry: { id, name: `${id}.pptx`, isFolder: false, size, modifiedAt: "source-version" },
  path: `Source/${id}.pptx`,
});
const destination = (id: number, size: number) => ({
  id: `destination-${id}`, name: `${id}.pptx`, size, isFolder: false,
  path: `Source/${id}.pptx`, modifiedAt: "destination-time", cTag: "destination-version",
});
const mapping = (id: number, size: number): SyncItem => ({
  id, sourceRootId: "1", sourceRootName: "Source", sourceId: String(id), sourceIsFolder: false,
  sourceParentId: "1", destinationRootId: "destination", destinationRootName: "Shared Documents",
  destinationId: `destination-${id}`, relativePath: `Source/${id}.pptx`, name: `${id}.pptx`,
  sourceSize: size, sourceModifiedAt: "source-version", destinationCTag: "destination-version",
  updatedAt: new Date(),
});
test("ignored files are a separate disjoint outcome with their own byte total and scope freshness", () => {
  const rule: SyncFileRule = { id: 1, failureId: 1, sourceId: 2, sourceRootId: 1,
    destinationRootId: "destination", destinationRootName: "Target", action: "ignore",
    expectedDestinationId: null, expectedETag: null, createdAt: new Date() };
  const inventory = new SyncInventory({ ...scope, fileRules: [rule] }, [source(2, 100), source(3, 200)], [], []);
  inventory.record(1, 2, "skipped");
  assert.equal(inventory.totals.sourceFiles, 2);
  assert.equal(inventory.totals.ignoredFiles, 1);
  assert.equal(inventory.totals.ignoredBytes, 100);
  assert.equal(inventory.totals.pendingFiles, 1);
  assert.equal(inventory.totals.failedFiles, 0);
  assert.notEqual(syncInventoryScopeKey({ ...scope, fileRules: [rule] }), syncInventoryScopeKey(scope));
  assert.equal(syncInventoryScopeKey({ ...scope, fileRules: [{ ...rule, destinationRootId: "other" }] }), syncInventoryScopeKey(scope));
});

test("inventory excludes folders and unrelated destinations, retaining distinct original and stored sizes", () => {
  const inventory = new SyncInventory(scope, [
    { root, entry: { ...root, isFolder: true }, path: "Source" },
    source(2, 1_000_000), source(3, 2_000_000),
  ], [mapping(2, 1_000_000)], [destination(2, 1_006_000), destination(99, 90_000_000)]);
  assert.equal(inventory.totals.sourceFiles, 2);
  assert.equal(inventory.totals.sourceBytes, 3_000_000);
  assert.equal(inventory.totals.synchronizedFiles, 1);
  assert.equal(inventory.totals.synchronizedBytes, 1_006_000);
  assert.equal(inventory.totals.pendingFiles, 1);
  assert.equal(inventory.totals.notSynchronizedFiles, 1);
});

test("repeated failures count files, not issue occurrences; recovery moves a file between disjoint totals", () => {
  const inventory = new SyncInventory(scope, [source(2, 10), source(3, 20)], [], []);
  for (let attempt = 0; attempt < 48; attempt++) inventory.record(1, 2, "failed");
  inventory.record(1, 3, "conflict");
  assert.equal(inventory.totals.failedFiles, 2);
  assert.equal(inventory.totals.pendingFiles, 0);
  inventory.record(1, 2, "copied", destination(2, 12));
  inventory.record(1, 2, "unchanged", destination(2, 12));
  inventory.record(1, 3, "skipped");
  inventory.record(99, 2, "copied", destination(2, 999));
  assert.equal(inventory.totals.synchronizedFiles, 1);
  assert.equal(inventory.totals.synchronizedBytes, 12);
  assert.equal(inventory.totals.failedFiles, 0);
  assert.equal(inventory.totals.pendingFiles, 1);
  assert.equal(inventory.totals.sourceFiles,
    inventory.totals.synchronizedFiles + inventory.totals.notSynchronizedFiles);
});

test("unknown source sizes are disclosed rather than presented as a complete byte total", () => {
  const inventory = new SyncInventory(scope, [source(2), source(3, 0), source(4, 20)], [], []);
  assert.equal(inventory.totals.sourceUnknownSizeFiles, 1);
  assert.equal(inventory.totals.sourceBytes, 20);
  assert.equal(inventory.totals.sourceFiles, 3);
  assert.equal(new SyncInventory(scope, [], [], []).totals.sourceFiles, 0);
});

test("stale, moved, missing or modified copies do not count as currently synchronized", () => {
  for (const variation of [
    { sourceSize: 9 }, { sourceModifiedAt: "old" }, { destinationCTag: "edited" },
    { relativePath: "Source/old-name.pptx" }, { name: "old-name.pptx" },
    { destinationRootId: "other-scope" },
  ]) {
    const inventory = new SyncInventory(scope, [source(2, 10)],
      [{ ...mapping(2, 10), ...variation }], [destination(2, 16)]);
    assert.equal(inventory.totals.synchronizedFiles, 0);
    assert.equal(inventory.totals.pendingFiles, 1);
  }
  assert.equal(new SyncInventory(scope, [source(2, 10)], [mapping(2, 10)], []).totals.synchronizedFiles, 0);
});

test("scope identity is stable under ordering but changes for destination, roots and exclusions", () => {
  const roots = [root, { id: 4, name: "Another" }];
  const excluded = [{ rootId: 1, id: 7, name: "Excluded", ancestorIds: [1] }];
  const key = syncInventoryScopeKey({ ...scope, sourceFolders: roots, excludedFolders: excluded });
  assert.equal(key, syncInventoryScopeKey({
    ...scope, sourceFolders: [...roots].reverse(), excludedFolders: excluded,
  }));
  assert.notEqual(key, syncInventoryScopeKey({ ...scope, sourceFolders: roots }));
  assert.notEqual(key, syncInventoryScopeKey({ ...scope, sourceFolders: roots, excludedFolders: [
    { ...excluded[0], id: 8 },
  ] }));
  assert.notEqual(syncInventoryScopeKey(scope),
    syncInventoryScopeKey({ ...scope, destinationFolderId: "another" }));
});

test("a full inventory is saved before transfers and its progress can be saved before run completion", async () => {
  const saved: Array<{ summary: SyncRunSummary }> = [];
  const database = {
    update: () => ({
      set: (value: { summary: SyncRunSummary }) => ({
        where: async () => { saved.push(structuredClone(value)); },
      }),
    }),
  } as unknown as typeof import("@workspace/db")["db"];
  const inventory = new SyncInventory(scope, [source(2, 10)], [], []);
  const summary: SyncRunSummary = {
    copiedFiles: 0, updatedFiles: 0, createdFolders: 0, deletedItems: 0, conflicts: 0,
    inventory: inventory.totals,
  };
  const journal = new SyncRunJournal(database, "test-run");
  journal.progress(summary, []);
  await journal.flush();
  assert.equal(saved[0].summary.inventory?.pendingFiles, 1);
  inventory.record(1, 2, "copied", destination(2, 16));
  await journal.flush();
  assert.equal(saved[1].summary.inventory?.synchronizedFiles, 1);
  assert.equal(saved[1].summary.inventory?.synchronizedBytes, 16);
  assert.equal(saved[1].summary.inventory?.sourceBytes, 10);

  const retryJournal = new SyncRunJournal(database, "retry-run");
  retryJournal.progress({
    createdFolders: 0, copiedFiles: 0, updatedFiles: 0, deletedItems: 0, conflicts: 0,
    fileProgress: { totalFiles: 2, processedFiles: 0 },
  }, []);
  await retryJournal.flush();
  assert.deepEqual(saved[2].summary.fileProgress, { totalFiles: 2, processedFiles: 0 });
});
