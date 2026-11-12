import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderBackoffError, ProviderGate, retryDelay } from "@workspace/shufflrr/http-policy";
import { SetSyncIntervalBody, RetryAllSyncFilesResponse, DismissAllSyncFailuresResponse } from "@workspace/api-zod";
import { applyDelta, scopeSnapshot } from "./sharepoint-snapshot";
import type { SyncDriveItem } from "./sharepoint";
import { performSync } from "./sync-runner";
import { syncItemsTable, syncFileRulesTable, type SyncItem, type SyncFileRule } from "@workspace/db/schema";
import { approvedOverwrite, fileInRuleScope } from "./sync-file-rules";
import { ResolveSyncConflictsBody, ReenableSyncFilesBody } from "@workspace/api-zod";
import { ShufflrrError, type ShufflrrClient } from "@workspace/shufflrr";
import type { SyncConflict, SyncLogEventInput, SyncRunSummary } from "@workspace/db/schema";
import { syncSchedulerDelay } from "./sync-scheduler";
import { GetSyncRunEventsQueryParams } from "@workspace/api-zod";
import { SaveSyncConfigBody } from "@workspace/api-zod";
import { excludedMappingIds, validateFolderExclusions } from "./sync-exclusions";
import { FileTransferError } from "./sync-transfer";
import { AccessError } from "./sharepoint";
import { canContinueAfterFileError } from "./sync-error-policy";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { syncFailureRoutes } from "../routes/sync-failures";
import { setSyncEnabledState, syncPauseCheckpoint, SyncPauseRequested } from "./sync-control";
import { uploadSizeNote } from "./sync-office-upload";

function clock() {
  let time = Date.UTC(2026, 0, 1);
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

test("Retry-After supports seconds, HTTP dates, zero, and invalid-header backoff", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(retryDelay("120", 0, now), 120_000);
  assert.equal(retryDelay(new Date(now + 60_000).toUTCString(), 0, now), 60_000);
  assert.equal(retryDelay("0", 0, now), 0);
  assert.ok(retryDelay("invalid", 2, now) >= 4000);
  assert.ok(retryDelay(null, 0, now) >= 1000);
});

test("shared gate paces concurrent requests and honors a complete provider delay", async () => {
  const time = clock();
  const gate = new ProviderGate("test", 250, time.now, time.sleep);
  const starts: number[] = [];
  await Promise.all([1, 2, 3].map(() => gate.request(async () => {
    starts.push(time.now());
    return new Response(null, { status: 200 });
  })));
  assert.ok(starts[1] - starts[0] >= 250);
  assert.ok(starts[2] - starts[1] >= 250);
  const before = time.now();
  let calls = 0;
  await gate.request(async () => {
    calls++;
    return calls === 1
      ? new Response(null, { status: 429, headers: { "Retry-After": "8" } })
      : new Response(null, { status: 200 });
  });
  assert.equal(calls, 2);
  assert.ok(time.now() - before >= 8000);
});

test("long cooldowns defer work without shortening the provider delay", async () => {
  const time = clock();
  const gate = new ProviderGate("test", 250, time.now, time.sleep);
  let calls = 0;
  const send = async () => {
    calls++;
    return new Response(null, { status: 429, headers: { "Retry-After": "120" } });
  };
  const start = time.now();
  await assert.rejects(gate.request(send), error =>
    error instanceof ProviderBackoffError && error.retryAt.getTime() === start + 120_000);
  await assert.rejects(gate.request(send), ProviderBackoffError);
  assert.equal(calls, 1);
});

test("transient reads have bounded retries; ambiguous writes are never replayed", async () => {
  const time = clock();
  let calls = 0;
  const failing = async () => { calls++; return new Response(null, { status: 503 }); };
  await assert.rejects(new ProviderGate("test", 250, time.now, time.sleep).request(failing), ProviderBackoffError);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(new ProviderGate("test", 250, time.now, time.sleep).request(failing, "POST"), ProviderBackoffError);
  assert.equal(calls, 1);
});

function item(id: string, name: string, parentId?: string, isFolder = false): SyncDriveItem {
  return { id, name, parentId, isFolder, size: 0, modifiedAt: "" };
}
const root = item("root", "Shared Documents", undefined, true);

test("delta renames and moves recalculate descendants by ID, not stale paths", () => {
  const old = new Map([
    root, item("a", "Old folder", "root", true), item("file", "deck.pptx", "a"),
    item("b", "Destination", "root", true),
  ].map(row => [row.id, row]));
  const next = applyDelta(old, [{ id: "a", deleted: false, item: item("a", "Renamed", "b", true) }]);
  const scope = scopeSnapshot(next, "root");
  assert.equal(scope.records.find(row => row.id === "file")?.path, "Destination/Renamed/deck.pptx");
  assert.equal(old.get("a")?.name, "Old folder");
});

test("folder deletions prune descendants, but preserve children moved out of the folder", () => {
  const old = new Map([
    root, item("a", "Removed", "root", true), item("file", "gone.pptx", "a"),
    item("moved", "keep.pptx", "a"),
  ].map(row => [row.id, row]));
  const next = applyDelta(old, [
    { id: "a", deleted: true }, { id: "moved", deleted: false, item: item("moved", "keep.pptx", "root") },
  ]);
  assert.equal(next.has("file"), false);
  assert.equal(next.has("moved"), true);
  assert.equal(scopeSnapshot(next, "root").records.length, 1);
});

test("empty and duplicate delta batches preserve unchanged items and use the last change", () => {
  const old = new Map([root, item("f", "original.pptx", "root")].map(row => [row.id, row]));
  assert.deepEqual([...applyDelta(old, []).values()], [...old.values()]);
  const next = applyDelta(old, [
    { id: "f", deleted: true },
    { id: "f", deleted: false, item: item("f", "latest.pptx", "root") },
  ]);
  assert.equal(next.get("f")?.name, "latest.pptx");
  assert.throws(() => scopeSnapshot(next, "missing"), /completed change snapshot/);
});

test("all six polling intervals validate, while unsupported values are rejected", () => {
  for (const value of [1, 5, 30, 60, 300, 3600]) {
    assert.equal(SetSyncIntervalBody.safeParse({ pollIntervalSeconds: value }).success, true);
  }
  for (const value of [0, -1, 2, 15, 120, 3601, "1", null, undefined]) {
    assert.equal(SetSyncIntervalBody.safeParse({ pollIntervalSeconds: value }).success, false);
  }
});

test("one retry group processes only its three files and never deletes or logs unrelated copies", async () => {
  const fixture = engineFixture([mapping(1, "1", "existing-folder", true), mapping(9, "99", "stale", false)], [
    { ...item("existing-folder", "Source", "root", true), path: "Source" },
    { ...item("stale", "removed.pdf", "existing-folder"), path: "Source/removed.pdf" },
    { ...item("unrelated", "unrelated.pdf", "existing-folder"), path: "Source/unrelated.pdf" },
  ]);
  let scans = 0;
  const downloads: number[] = [];
  const client = sourceClient();
  client.contents = async () => {
    scans++;
    return [sourceFile, { ...sourceFile, id: 6, name: "second.pdf" },
      { ...sourceFile, id: 7, name: "third.pdf" }, { ...sourceFile, id: 8, name: "not-requested.pdf" }];
  };
  client.download = async id => {
    downloads.push(id);
    if (id === 3) throw new FileTransferError("Test item-local failure");
    return new Response("abc");
  };
  const log = collectLog();
  const result = await performSync(fixture.database, client, { ...engineConfig,
    retryTargets: [3, 6, 7].map(sourceId => ({ sourceRootId: 1, sourceId })),
  }, () => {}, fixture.providers, log);
  assert.equal(scans, 1, "Discovery is shared by all three retries");
  assert.deepEqual(downloads, [3, 6, 7]);
  assert.deepEqual(result.summary.fileProgress, { totalFiles: 3, processedFiles: 3 });
  assert.equal(result.summary.runKind, "retry");
  assert.equal(result.summary.copiedFiles, 2);
  assert.equal(result.failedFiles, 1);
  assert.equal(result.summary.deletedItems, 0);
  assert.equal(result.conflicts.length, 0, "Unrelated destination-only files do not add retry conflicts");
  assert.ok(!fixture.calls.some(call => call.startsWith("delete:") || call.includes("not-requested")));
  assert.ok(fixture.rows().some(row => row.sourceId === "99"));
  assert.equal(result.summary.inventory, undefined, "A retry cannot replace the full-scope dashboard scan");
});

function engineFixture(seed: SyncItem[] = [], records: (SyncDriveItem & { path: string })[] = []) {
  let rows = [...seed];
  let writes = 0;
  let removedRules = 0;
  const calls: string[] = [];
  const database = {
    select: () => ({ from: () => ({ where: async () => [...rows] }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoUpdate: () => {
          writes++;
          const saved = { ...value, id: rows.length + 1 } as unknown as SyncItem;
          if (table === syncItemsTable) {
            rows = rows.filter(row => row.sourceId !== saved.sourceId || row.sourceIsFolder !== saved.sourceIsFolder);
            rows.push(saved);
          }
          return Object.assign(Promise.resolve(), { returning: async () => [saved] });
        },
      }),
    }),
    delete: (table: unknown) => ({ where: async (condition: SQL) => {
      if (table === syncFileRulesTable) removedRules++;
      if (table === syncItemsTable) {
        const ids = new Set(new PgDialect().sqlToQuery(condition).params);
        rows = rows.filter(row => !ids.has(row.id));
      }
    } }),
  } as unknown as typeof import("@workspace/db")["db"];
  let sequence = 0;
  const providers: Parameters<typeof performSync>[4] = {
    loadDestinationSnapshot: async () => ({ root, records, driveId: "test-drive" }),
    getSyncPathItem: async (_root, path) => {
      const found = records.find(record => record.path === path);
      if (!found) throw new AccessError("itemNotFound", "Missing test destination", 404);
      return found;
    },
    createSyncFolder: async (parent, name) => {
      calls.push(`folder:${parent}:${name}`);
      return item(`new-${++sequence}`, name, parent, true);
    },
    updateSyncItem: async (id, update) => {
      calls.push(`move:${id}`);
      return item(id, update.name, update.parentId, true);
    },
    uploadSyncFile: async (parent, name, _bytes, existingId) => {
      calls.push(`upload:${parent}:${name}:${existingId ?? "new"}`);
      return { ...item(existingId ?? `new-${++sequence}`, name, parent), cTag: "new-tag" };
    },
    deleteSyncItem: async id => { calls.push(`delete:${id}`); },
  };
  return { database, providers, calls, writes: () => writes, rows: () => rows, removedRules: () => removedRules };
}

const sourceRoot = { id: 1, name: "Source", isFolder: true };
const sourceFile = { id: 3, name: "deck.pptx", isFolder: false, size: 3, modifiedAt: "new" };
const engineConfig = {
  destinationFolderId: "root", destinationFolderName: "Shared Documents",
  sourceFolders: [{ id: 1, name: "Source" }],
};
function sourceClient(nested = false, download = async () => new Response("abc")): ShufflrrClient {
  return {
    folder: async () => sourceRoot,
    contents: async (id: number) => id === 1
      ? nested ? [{ id: 2, name: "Nested", isFolder: true }] : [sourceFile]
      : [sourceFile],
    download,
  } as unknown as ShufflrrClient;
}
function mapping(id: number, sourceId: string, destinationId: string, folder: boolean): SyncItem {
  return {
    id, sourceRootId: "1", sourceRootName: "Source", sourceId, sourceIsFolder: folder,
    sourceParentId: folder ? null : "1", destinationRootId: "root", destinationRootName: "Shared Documents",
    destinationId, relativePath: folder ? "Source" : "Source/deck.pptx",
    name: folder ? "Source" : "deck.pptx", sourceModifiedAt: folder ? null : "old",
    sourceSize: folder ? 0 : 3, destinationCTag: folder ? null : "old-tag", updatedAt: new Date(0),
  };
}

const ignoreRule: SyncFileRule = { id: 7, failureId: 7, sourceId: 3, sourceRootId: 1,
  destinationRootId: "root", destinationRootName: "Shared Documents", action: "ignore",
  expectedDestinationId: null, expectedETag: null, createdAt: new Date(0) };
const overwriteRule: SyncFileRule = { ...ignoreRule, action: "overwrite",
  expectedDestinationId: "existing-file", expectedETag: '"approved-version"' };
function conflictFixture() {
  return engineFixture([mapping(1, "1", "existing-folder", true)], [
    { ...item("existing-folder", "Source", "root", true), path: "Source" },
    { ...item("existing-file", "deck.pptx", "existing-folder"), eTag: '"approved-version"', path: "Source/deck.pptx" },
  ]);
}

function archiveFixture() {
  const records = [
    { ...item("existing-folder", "Source", "root", true), path: "Source" },
    { ...item("existing-file", "deck.pptx", "existing-folder"), cTag: "old-tag", eTag: '"archive-version"', path: "Source/deck.pptx" },
  ];
  const f = engineFixture([mapping(1, "1", "existing-folder", true), {
    ...mapping(2, "3", "existing-file", false), sourceModifiedAt: sourceFile.modifiedAt,
  }], records);
  const client = sourceClient();
  client.contents = async () => [{ ...sourceFile, isArchived: true }];
  return { ...f, client, records };
}

test("archive policy is opt-in and retains an unchanged archived copy when disabled", async () => {
  const f = archiveFixture();
  const result = await performSync(f.database, f.client, engineConfig, () => {}, f.providers);
  assert.ok(!f.calls.some(call => call.startsWith("delete:") || call.startsWith("upload:")));
  assert.equal(result.summary.archivedFiles, 1);
  assert.equal(result.summary.inventory?.sourceFiles, 1);
});

test("an incomplete source listing never authorizes archive deletions", async () => {
  const f = archiveFixture();
  f.client.contents = async id => {
    if (id !== 1) throw new Error("Source listing interrupted");
    return [{ ...sourceFile, isArchived: true }, { id: 2, name: "Nested", isFolder: true }];
  };
  await assert.rejects(performSync(f.database, f.client, { ...engineConfig, treatArchivedAsDeleted: true }, () => {}, f.providers));
  assert.ok(!f.calls.some(call => call.startsWith("delete:") || call.startsWith("upload:")));
  assert.ok(f.rows().some(row => row.sourceId === "3"));
});

test("archive policy conditionally deletes only the managed copy, logs why, and allows unarchived files to sync again", async () => {
  const f = archiveFixture();
  const log = collectLog();
  let deleteTag: string | undefined;
  const remove = f.providers!.deleteSyncItem;
  f.providers!.deleteSyncItem = async (id, tag) => { deleteTag = tag; await remove(id, tag); };
  const config = { ...engineConfig, treatArchivedAsDeleted: true };
  const result = await performSync(f.database, f.client, config, () => {}, f.providers, log);
  assert.equal(deleteTag, '"archive-version"');
  assert.equal(result.summary.deletedItems, 1);
  assert.equal(result.summary.inventory?.sourceFiles, 0);
  assert.equal(result.summary.inventory?.archivedFiles, 1);
  assert.deepEqual(result.summary.fileProgress, { totalFiles: 1, processedFiles: 1 });
  assert.ok(log.events.some(event => event.status === "deleted" && event.message.includes("archived")));
  assert.ok(!f.calls.some(call => call.startsWith("upload:")));
  assert.ok(!f.rows().some(row => row.sourceId === "3"));
  f.records.splice(1, 1);
  f.client.contents = async () => [{ ...sourceFile, isArchived: false }];
  const restored = await performSync(f.database, f.client, config, () => {}, f.providers);
  assert.equal(restored.summary.copiedFiles, 1);
  assert.ok(f.rows().some(row => row.sourceId === "3"));
});

test("changed and unverifiable archived SharePoint copies remain conflicts instead of being deleted", async () => {
  for (const patch of [{ cTag: "edited" }, { eTag: undefined }]) {
    const f = archiveFixture();
    Object.assign(f.records[1], patch);
    const log = collectLog();
    const result = await performSync(f.database, f.client, { ...engineConfig, treatArchivedAsDeleted: true }, () => {}, f.providers, log);
    assert.ok(!f.calls.some(call => call.startsWith("delete:") || call.startsWith("upload:")));
    assert.ok(result.conflicts.length > 0);
    assert.ok(log.events.some(event => event.status === "conflict" && event.message.includes("archived")));
  }
});

test("archived files still honor ignore rules, and targeted retries never remove their copies", async () => {
  for (const config of [
    { ...engineConfig, treatArchivedAsDeleted: true, fileRules: [ignoreRule] },
    { ...engineConfig, treatArchivedAsDeleted: true, retryTargets: [{ sourceRootId: 1, sourceId: 3 }] },
  ]) {
    const f = archiveFixture();
    await performSync(f.database, f.client, config, () => {}, f.providers);
    assert.ok(!f.calls.some(call => call.startsWith("delete:") || call.startsWith("upload:")));
    assert.ok(f.rows().some(row => row.sourceId === "3"));
  }
});

test("an untracked archived target is retained, and a rejected conditional delete cannot erase its mapping", async () => {
  const untracked = archiveFixture();
  const f = engineFixture(untracked.rows().filter(row => row.sourceId !== "3"), untracked.records);
  await performSync(f.database, untracked.client, { ...engineConfig, treatArchivedAsDeleted: true }, () => {}, f.providers);
  assert.ok(!f.calls.some(call => call.startsWith("delete:") || call.startsWith("upload:")));
  const changed = archiveFixture();
  changed.providers!.deleteSyncItem = async () => { throw new AccessError("preconditionFailed", "Version changed", 412); };
  await assert.rejects(performSync(changed.database, changed.client, { ...engineConfig, treatArchivedAsDeleted: true }, () => {}, changed.providers));
  assert.ok(changed.rows().some(row => row.sourceId === "3"));
});
test("ignore rules skip transfers without new failure issues and report separate totals", async () => {
  const f = conflictFixture();
  const log = collectLog();
  const client = sourceClient(false, async () => { assert.fail("Ignored file must not be downloaded"); });
  const outcome = await performSync(f.database, client, { ...engineConfig, fileRules: [ignoreRule] }, () => {}, f.providers, log);
  assert.equal(f.calls.length, 0);
  assert.equal(outcome.conflicts.length, 0);
  assert.equal(outcome.failedFiles, 0);
  assert.equal(outcome.summary.inventory?.ignoredFiles, 1);
  assert.equal(outcome.summary.inventory?.ignoredBytes, 3);
  assert.equal(outcome.summary.inventory?.notSynchronizedFiles, 0);
  const event = log.events.find(event => event.path === "Source/deck.pptx")!;
  assert.equal(event.status, "skipped");
  assert.equal(event.sourceFile, undefined, "Intentional ignore must not add an actionable failure occurrence");
});
test("ignore rules follow source identities through renames without touching old copies", async () => {
  const f = conflictFixture();
  const client = sourceClient();
  client.contents = async () => [{ ...sourceFile, name: "renamed.pptx" }];
  await performSync(f.database, client, { ...engineConfig, fileRules: [ignoreRule] }, () => {}, f.providers);
  assert.ok(!f.calls.some(call => call.startsWith("upload:") || call.startsWith("delete:")));
});
test("ignored mapped copies remain protected even if their source is removed", async () => {
  const seed = [mapping(1, "1", "existing-folder", true), mapping(2, "3", "existing-file", false)];
  const f = engineFixture(seed, [
    { ...item("existing-folder", "Source", "root", true), path: "Source" },
    { ...item("existing-file", "deck.pptx", "existing-folder"), path: "Source/deck.pptx" },
  ]);
  const client = sourceClient(); client.contents = async () => [];
  await performSync(f.database, client, { ...engineConfig, fileRules: [ignoreRule] }, () => {}, f.providers);
  assert.ok(!f.calls.some(call => call.startsWith("delete:")));
  assert.ok(f.rows().some(row => row.sourceId === "3"));
});
test("reenabling restores ordinary conflicts and never silently adopts or overwrites a copy", async () => {
  const f = conflictFixture();
  const result = await performSync(f.database, sourceClient(), { ...engineConfig, fileRules: [] }, () => {}, f.providers);
  assert.equal(result.conflicts.length, 1);
  assert.ok(!f.calls.some(call => call.startsWith("upload:")));
  assert.ok(!f.rows().some(row => row.sourceId === "3"));
});
test("approved overwrite passes a version precondition and creates a mapping only after verified upload", async () => {
  const f = conflictFixture();
  let condition: string | undefined;
  const upload = f.providers.uploadSyncFile;
  f.providers.uploadSyncFile = async (...args) => { condition = args[4]; return upload(...args); };
  const result = await performSync(f.database, sourceClient(), { ...engineConfig, fileRules: [overwriteRule] }, () => {}, f.providers);
  assert.equal(condition, '"approved-version"');
  assert.equal(result.summary.updatedFiles, 1);
  assert.equal(result.conflicts.length, 0);
  assert.equal(f.rows().find(row => row.sourceId === "3")?.destinationId, "existing-file");
});
test("approved overwrite resolves a destination missing from the snapshot without creating a new file", async () => {
  const f = engineFixture([mapping(1, "1", "existing-folder", true)], [
    { ...item("existing-folder", "Source", "root", true), path: "Source" },
  ]);
  f.providers.getSyncPathItem = async (rootId, path) => {
    assert.equal(rootId, "root");
    assert.equal(path, "Source/deck.pptx");
    return { ...item("existing-file", "deck.pptx", "existing-folder"), eTag: '"approved-version"' };
  };
  const upload = f.providers.uploadSyncFile;
  f.providers.uploadSyncFile = async (...args) => {
    assert.equal(args[3], "existing-file");
    assert.equal(args[4], '"approved-version"', "The write must still enforce the approved version");
    return upload(...args);
  };
  const log = collectLog();
  const result = await performSync(f.database, sourceClient(), { ...engineConfig, fileRules: [overwriteRule] },
    () => {}, f.providers, log);
  assert.equal(result.summary.updatedFiles, 1);
  assert.equal(result.summary.copiedFiles, 0);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.failedFiles, 0);
  assert.equal(result.summary.inventory?.synchronizedFiles, 1);
  assert.equal(f.rows().find(row => row.sourceId === "3")?.destinationId, "existing-file");
  assert.equal(f.removedRules(), 1, "Only a verified success consumes the approval");
  assert.equal(log.events.find(event => event.path === "Source/deck.pptx")?.status, "updated");
});

test("live approved version takes precedence over stale cached metadata", async () => {
  const f = conflictFixture();
  f.providers.loadDestinationSnapshot = async () => ({ root, driveId: "test-drive", records: [
    { ...item("existing-folder", "Source", "root", true), path: "Source" },
    { ...item("existing-file", "deck.pptx", "existing-folder"), eTag: '"stale-cache-version"', path: "Source/deck.pptx" },
  ] });
  const result = await performSync(f.database, sourceClient(), { ...engineConfig, fileRules: [overwriteRule] }, () => {}, f.providers);
  assert.equal(result.summary.updatedFiles, 1);
  assert.ok(f.calls.includes("upload:existing-folder:deck.pptx:existing-file"));
});

test("missing, changed, moved, folder and other-owned destinations cannot use an old approval", async t => {
  const approved = { ...item("existing-file", "deck.pptx", "existing-folder"), eTag: '"approved-version"' };
  for (const scenario of [
    { name: "missing", live: null },
    { name: "replaced", live: { ...approved, id: "replacement" } },
    { name: "changed version", live: { ...approved, eTag: '"edited"' } },
    { name: "missing version", live: { ...approved, eTag: undefined } },
    { name: "folder", live: { ...approved, isFolder: true } },
    { name: "moved parent", live: { ...approved, parentId: "another-folder" } },
    { name: "another owner", live: approved, anotherOwner: true },
  ]) await t.test(scenario.name, async () => {
    const f = conflictFixture();
    if (scenario.anotherOwner) f.rows().push({ ...mapping(2, "other-source", "existing-file", false) });
    f.providers.getSyncPathItem = async () => {
      if (!scenario.live) throw new AccessError("itemNotFound", "Destination absent", 404);
      return scenario.live;
    };
    const log = collectLog();
    const result = await performSync(f.database, sourceClient(false, async () => {
      assert.fail("Unsafe overwrites must be rejected before downloading");
    }), { ...engineConfig, fileRules: [overwriteRule], retryTargets: [{ sourceRootId: 1, sourceId: 3 }] },
    () => {}, f.providers, log);
    assert.equal(result.summary.updatedFiles, 0);
    assert.equal(result.conflicts.length, 1);
    assert.ok(!f.calls.some(call => call.startsWith("upload:")));
    assert.ok(!f.rows().some(row => row.sourceId === "3"));
    assert.equal(f.removedRules(), 0);
    assert.match(log.events.find(event => event.path === "Source/deck.pptx")?.message ?? "", /SharePoint changed since overwrite approval/);
  });
});

test("a live lookup permission failure stops the run rather than falling back to a new upload", async () => {
  const f = conflictFixture();
  f.providers.getSyncPathItem = async () => { throw new AccessError("accessDenied", "Denied", 403); };
  await assert.rejects(performSync(f.database, sourceClient(), { ...engineConfig, fileRules: [overwriteRule] },
    () => {}, f.providers));
  assert.equal(f.removedRules(), 0);
  assert.ok(!f.calls.some(call => call.startsWith("upload:")));
});

test("files without overwrite approval never use the approval lookup", async () => {
  const f = conflictFixture();
  f.providers.getSyncPathItem = async () => { assert.fail("Ordinary conflicts must not use the approved lookup"); };
  const result = await performSync(f.database, sourceClient(), engineConfig, () => {}, f.providers);
  assert.equal(result.conflicts.length, 1);
});

test("failed overwrite never adopts a file or records synchronization success", async () => {
  const f = conflictFixture();
  f.providers.uploadSyncFile = async () => { throw new AccessError("PreconditionFailed", "Destination changed after approval", 412); };
  const result = await performSync(f.database, sourceClient(), { ...engineConfig, fileRules: [overwriteRule] }, () => {}, f.providers);
  assert.equal(result.summary.updatedFiles, 0);
  assert.equal(result.failedFiles, 1);
  assert.ok(!f.rows().some(row => row.sourceId === "3"));
  assert.equal(f.removedRules(), 0);
});
test("overwrite refuses a replaced destination, folders, missing versions and another source's ownership", () => {
  const file = { id: "existing-file", isFolder: false };
  assert.equal(approvedOverwrite(overwriteRule, file, false), true);
  assert.equal(approvedOverwrite(overwriteRule, { ...file, id: "replacement" }, false), false);
  assert.equal(approvedOverwrite(overwriteRule, { ...file, isFolder: true }, false), false);
  assert.equal(approvedOverwrite({ ...overwriteRule, expectedETag: null }, file, false), false);
  assert.equal(approvedOverwrite(overwriteRule, file, true), false);
  assert.equal(approvedOverwrite(ignoreRule, file, false), false);
});
test("resolution validation bounds selections and preserves source/target/exclusion boundaries", () => {
  assert.equal(ResolveSyncConflictsBody.safeParse({ failureIds: [], action: "overwrite" }).success, false);
  assert.equal(ResolveSyncConflictsBody.safeParse({ failureIds: [1], action: "adopt" }).success, false);
  assert.equal(ReenableSyncFilesBody.safeParse({ ruleIds: Array.from({ length: 101 }, (_, i) => i + 1) }).success, false);
  const file = { destinationRootId: "root", sourceRootId: 1, ancestorIds: [1, 2] };
  const scope = { ...engineConfig, excludedFolders: [] };
  assert.equal(fileInRuleScope(file, scope), true);
  assert.equal(fileInRuleScope(file, { ...scope, destinationFolderId: "different" }), false);
  assert.equal(fileInRuleScope(file, { ...scope, sourceFolders: [] }), false);
  assert.equal(fileInRuleScope(file, { ...scope, excludedFolders: [{ id: 2, rootId: 1, name: "excluded", ancestorIds: [1] }] }), false);
});

const exclusion = { id: 2, name: "Nested", rootId: 1, ancestorIds: [1] };
function excludedFixture(withGoneParent = false) {
  const nestedPath = withGoneParent ? "Source/Gone/Nested" : "Source/Nested";
  const seed = [
    mapping(1, "1", "d-root", true),
    { ...mapping(2, "2", "d-nested", true), sourceParentId: withGoneParent ? "7" : "1",
      name: "Nested", relativePath: nestedPath },
    { ...mapping(3, "3", "d-hidden", false), sourceParentId: "2", relativePath: `${nestedPath}/deck.pptx` },
  ];
  const records = [
    { ...item("d-root", "Source", "root", true), path: "Source" },
    { ...item("d-nested", "Nested", withGoneParent ? "d-gone" : "d-root", true), path: nestedPath },
    { ...item("d-hidden", "deck.pptx", "d-nested"), path: `${nestedPath}/deck.pptx` },
  ];
  if (withGoneParent) {
    seed.push({ ...mapping(7, "7", "d-gone", true), sourceParentId: "1", name: "Gone", relativePath: "Source/Gone" });
    records.push({ ...item("d-gone", "Gone", "d-root", true), path: "Source/Gone" });
  }
  return engineFixture(seed, records);
}

test("save contract requires explicit exclusions so an old client cannot silently clear them", () => {
  assert.equal(SaveSyncConfigBody.safeParse(engineConfig).success, false);
  assert.equal(SaveSyncConfigBody.safeParse({ ...engineConfig, excludedFolders: [exclusion] }).success, true);
  assert.equal(SaveSyncConfigBody.safeParse({ ...engineConfig, excludedFolders: [{ ...exclusion, ancestorIds: [] }] }).success, false);
});

test("exclusion validation verifies ancestry and canonical names; nested exclusions collapse to their parent", async () => {
  const client = {
    contents: async (id: number) => id === 1
      ? [{ id: 2, name: "Canonical", isFolder: true }]
      : [{ id: 5, name: "Deep", isFolder: true }],
  } as unknown as ShufflrrClient;
  const verified = await validateFolderExclusions(client, engineConfig.sourceFolders, [
    exclusion, { id: 5, name: "Untrusted", rootId: 1, ancestorIds: [1, 2] },
  ]);
  assert.deepEqual(verified, [{ ...exclusion, name: "Canonical" }]);
  for (const invalid of [
    { ...exclusion, rootId: 99 }, { ...exclusion, id: 1 },
    { ...exclusion, ancestorIds: [1, 1] }, { ...exclusion, ancestorIds: [99] },
    { ...exclusion, ancestorIds: [1, 2] }, { ...exclusion, id: 404 },
  ]) await assert.rejects(validateFolderExclusions(client, engineConfig.sourceFolders, [invalid]));
  await assert.rejects(validateFolderExclusions(client, engineConfig.sourceFolders, [exclusion, exclusion]));
});

test("excluded subtrees are not enumerated, downloaded, created, updated or deleted", async () => {
  const fixture = excludedFixture();
  const contentsCalls: number[] = [];
  const client = {
    folder: async () => sourceRoot,
    contents: async (id: number) => {
      contentsCalls.push(id);
      assert.equal(id, 1, "Excluded contents must never be fetched");
      return [{ id: 2, name: "Nested", isFolder: true }, { ...sourceFile, id: 4, name: "active.pptx" }];
    },
    download: async (id: number) => { assert.equal(id, 4); return new Response("abc"); },
  } as unknown as ShufflrrClient;
  const log = collectLog();
  const result = await performSync(fixture.database, client,
    { ...engineConfig, excludedFolders: [exclusion] }, () => {}, fixture.providers, log);
  assert.deepEqual(contentsCalls, [1]);
  assert.deepEqual(fixture.calls, ["upload:d-root:active.pptx:new"]);
  assert.equal(result.summary.deletedItems, 0);
  assert.equal(result.summary.conflicts, 0);
  assert.equal(log.events.find(event => event.path === "Source/Nested")?.status, "skipped");
  assert.equal(log.events.find(event => event.path === "Source/Nested/deck.pptx")?.status, "skipped");
});

test("copies remain protected by folder ID even after an excluded subtree disappears from source", async () => {
  const fixture = excludedFixture();
  const client = { folder: async () => sourceRoot, contents: async () => [] } as unknown as ShufflrrClient;
  await performSync(fixture.database, client, { ...engineConfig, excludedFolders: [exclusion] },
    () => {}, fixture.providers);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual([...excludedMappingIds(fixture.rows(), [exclusion])].sort(), [2, 3]);
});

test("saving an unchanged, already verified exclusion does not require a deleted source folder to exist", async () => {
  const client = { contents: async () => { throw new Error("Deleted source must not be queried"); } } as unknown as ShufflrrClient;
  const result = await validateFolderExclusions(client, engineConfig.sourceFolders,
    [{ ...exclusion, name: "untrusted name" }], [exclusion]);
  assert.deepEqual(result, [exclusion]);
});

test("source ancestor deletion cannot recursively delete excluded descendants", async () => {
  const fixture = excludedFixture(true);
  const client = { folder: async () => sourceRoot, contents: async () => [] } as unknown as ShufflrrClient;
  const log = collectLog();
  await performSync(fixture.database, client, {
    ...engineConfig, excludedFolders: [{ ...exclusion, ancestorIds: [1, 7] }],
  }, () => {}, fixture.providers, log);
  assert.deepEqual(fixture.calls, []);
  assert.match(log.events.find(event => event.path === "Source/Gone")?.message ?? "", /contains excluded/);
});

test("source ancestor deletion also preserves preexisting SharePoint-only content", async () => {
  const fixture = engineFixture([
    mapping(1, "1", "d-root", true),
    { ...mapping(7, "7", "d-gone", true), sourceParentId: "1", relativePath: "Source/Gone", name: "Gone" },
  ], [
    { ...item("d-root", "Source", "root", true), path: "Source" },
    { ...item("d-gone", "Gone", "d-root", true), path: "Source/Gone" },
    { ...item("unmanaged", "private.txt", "d-gone"), path: "Source/Gone/private.txt" },
  ]);
  const client = { folder: async () => sourceRoot, contents: async () => [] } as unknown as ShufflrrClient;
  const result = await performSync(fixture.database, client, engineConfig, () => {}, fixture.providers);
  assert.deepEqual(fixture.calls, []);
  assert.equal(result.conflicts.find(conflict => conflict.path === "Source/Gone/private.txt")?.kind, "untracked-sharepoint-item");
});

test("reinclusion reconciles retained mappings rather than producing initial path conflicts", async () => {
  const fixture = excludedFixture();
  const result = await performSync(fixture.database, sourceClient(true),
    { ...engineConfig, excludedFolders: [] }, () => {}, fixture.providers);
  assert.deepEqual(fixture.calls, ["upload:d-nested:deck.pptx:d-hidden"]);
  assert.equal(result.summary.updatedFiles, 1);
  assert.equal(result.summary.conflicts, 0);
});

test("targeted retry copies only the requested file and never performs mirror deletions", async () => {
  const fixture = engineFixture([
    mapping(1, "1", "d-root", true),
    { ...mapping(8, "8", "d-stale", false), name: "stale.txt", relativePath: "Source/stale.txt" },
  ], [
    { ...item("d-root", "Source", "root", true), path: "Source" },
    { ...item("d-stale", "stale.txt", "d-root"), path: "Source/stale.txt" },
  ]);
  const downloads: number[] = [];
  const client = {
    folder: async () => sourceRoot,
    contents: async () => [sourceFile, { ...sourceFile, id: 9, name: "unrelated.txt" }],
    download: async (id: number) => { downloads.push(id); return new Response("abc"); },
  } as unknown as ShufflrrClient;
  const result = await performSync(fixture.database, client, {
    ...engineConfig, retryTargets: [{ sourceRootId: 1, sourceId: 3 }],
  }, () => {}, fixture.providers);
  assert.deepEqual(result.summary.fileProgress, { totalFiles: 1, processedFiles: 1 });
  assert.deepEqual(downloads, [3]);
  assert.deepEqual(fixture.calls, ["upload:d-root:deck.pptx:new"]);
});

test("a targeted retry outside the current source tree fails before any destination write", async () => {
  const fixture = engineFixture();
  await assert.rejects(performSync(fixture.database, sourceClient(), {
    ...engineConfig, retryTargets: [{ sourceRootId: 1, sourceId: 999 }],
  }, () => {}, fixture.providers), /no longer in the selected sync scope/);
  assert.deepEqual(fixture.calls, []);
});

test("initial sync resolves newly created parents in the same run", async () => {
  const fixture = engineFixture();
  const result = await performSync(fixture.database, sourceClient(true), engineConfig, () => {}, fixture.providers);
  assert.deepEqual(fixture.calls, ["folder:root:Source", "folder:new-1:Nested", "upload:new-2:deck.pptx:new"]);
  assert.equal(result.summary.copiedFiles, 1);
  assert.equal(result.summary.inventory?.sourceFiles, 1);
  assert.equal(result.summary.inventory?.synchronizedFiles, 1);
  assert.equal(result.summary.inventory?.notSynchronizedFiles, 0);
  assert.deepEqual(result.summary.fileProgress, { totalFiles: 1, processedFiles: 1 });
  assert.equal(fixture.rows().length, 3);
});

test("source changes update an already mapped SharePoint file", async () => {
  const fixture = engineFixture(
    [mapping(1, "1", "dest-folder", true), mapping(2, "3", "dest-file", false)],
    [
      { ...item("dest-folder", "Source", "root", true), path: "Source" },
      { ...item("dest-file", "deck.pptx", "dest-folder"), cTag: "old-tag", path: "Source/deck.pptx" },
    ],
  );
  const result = await performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers);
  assert.deepEqual(fixture.calls, ["upload:dest-folder:deck.pptx:dest-file"]);
  assert.equal(result.summary.updatedFiles, 1);
});

test("untracked folder conflicts block the entire nested source tree without writes", async () => {
  const fixture = engineFixture([], [{ ...item("existing", "Source", "root", true), path: "Source" }]);
  const result = await performSync(fixture.database, sourceClient(true), engineConfig, () => {}, fixture.providers);
  assert.equal(result.conflicts[0]?.kind, "path-conflict");
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.writes(), 0);
});

test("a failed destination snapshot aborts before any destination mutations", async () => {
  const fixture = engineFixture();
  fixture.providers.loadDestinationSnapshot = async () => { throw new Error("incomplete feed"); };
  await assert.rejects(
    performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers),
    /incomplete feed/,
  );
  assert.deepEqual(fixture.calls, []);
});

function collectLog() {
  const events: SyncLogEventInput[] = [];
  let summary: SyncRunSummary | null = null;
  let conflicts: SyncConflict[] = [];
  return {
    events,
    get summary() { return summary; },
    get conflicts() { return conflicts; },
    record: async (event: SyncLogEventInput) => { events.push(event); },
    progress: (current: SyncRunSummary, found: SyncConflict[]) => { summary = current; conflicts = found; },
  };
}

test("newly enabled sync is picked up within one second regardless of its polling interval", () => {
  for (const interval of [1000, 5000, 30_000, 60_000, 300_000, 3_600_000]) {
    assert.equal(syncSchedulerDelay(interval), 1000);
  }
  assert.equal(syncSchedulerDelay(250), 250);
  assert.equal(syncSchedulerDelay(0), 1);
});

test("activity query validates run IDs, supported statuses and bounded page sizes", () => {
  const runId = "01234567-89ab-4cde-8fab-0123456789ab";
  assert.ok(GetSyncRunEventsQueryParams.safeParse({ runId, status: "failed", limit: "50" }).success);
  for (const input of [
    { runId: "invalid" }, { runId, status: "invented" }, { runId, limit: "201" }, { runId, after: "-1" },
  ]) assert.equal(GetSyncRunEventsQueryParams.safeParse(input).success, false);
});

test("activity records successful copies and created folders with their full paths", async () => {
  const fixture = engineFixture();
  const log = collectLog();
  await performSync(fixture.database, sourceClient(true), engineConfig, () => {}, fixture.providers, log);
  assert.deepEqual(log.events.map(row => row.status), ["created", "created", "copied"]);
  assert.equal(log.events.at(-1)?.path, "Source/Nested/deck.pptx");
  assert.equal(log.events.at(-1)?.destinationPath, "Shared Documents/Source/Nested/deck.pptx");
});

test("a conflict logs the exact folder and every descendant skipped under it", async () => {
  const fixture = engineFixture([], [{ ...item("existing", "Source", "root", true), path: "Source" }]);
  const log = collectLog();
  const result = await performSync(fixture.database, sourceClient(true), engineConfig, () => {}, fixture.providers, log);
  assert.deepEqual(log.events.map(row => row.status), ["conflict", "skipped", "skipped"]);
  assert.equal(result.summary.conflicts, 1);
  assert.deepEqual(fixture.calls, []);
});

test("verified deletions precede transfers even when an oversized file fails later", async () => {
  const fixture = engineFixture([
    { ...mapping(1, "99", "stale", false), relativePath: "Source/gone.pdf" },
  ], [
    { ...item("existing", "conflict.txt", "parent"), path: "Source/conflict.txt" },
    { ...item("stale", "gone.pdf", "root"), path: "Source/gone.pdf" },
  ]);
  const client = {
    folder: async () => sourceRoot,
    contents: async () => [
      { id: 4, name: "conflict.txt", isFolder: false },
      sourceFile,
      { id: 5, name: "huge.pptx", isFolder: false },
      { id: 6, name: "later.pdf", isFolder: false, size: 3 },
    ],
    download: async (id: number) => new Response("abc", {
      headers: id === 5 ? { "content-length": String(300_000_001) } : {},
    }),
  } as unknown as ShufflrrClient;
  const log = collectLog();
  const result = await performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, log);
  assert.equal(result.failedFiles, 1);
  assert.equal(log.summary?.copiedFiles, 2);
  assert.equal(log.summary?.createdFolders, 1);
  assert.equal(log.summary?.conflicts, 1);
  assert.deepEqual(log.summary?.fileProgress, { totalFiles: 4, processedFiles: 4 });
  assert.equal(log.conflicts[0]?.path, "Source/conflict.txt");
  assert.equal(log.events.find(row => row.status === "failed")?.path, "Source/huge.pptx");
  assert.match(log.events.find(row => row.status === "failed")!.message, /300 MB/);
  assert.equal(log.events.find(row => row.path === "Source/later.pdf")?.status, "copied");
  assert.equal(fixture.calls[0], "delete:stale");
  assert.equal(result.summary.deletedItems, 1);
  assert.ok(!fixture.rows().some(row => row.destinationId === "stale"));
  assert.ok(!log.events.some(row => /deletions deferred/i.test(row.message)));
});

test("file-local upload errors do not prevent later independent files from syncing", async () => {
  for (const error of [new FileTransferError("SharePoint did not confirm the upload."),
    new AccessError("InvalidName", "Invalid name", 400)]) {
    const fixture = engineFixture();
    const upload = fixture.providers.uploadSyncFile;
    fixture.providers.uploadSyncFile = async (...args) => {
      if (args[1] === sourceFile.name) throw error;
      return upload(...args);
    };
    const client = { folder: async () => sourceRoot, contents: async () => [
      sourceFile, { ...sourceFile, id: 6, name: "later.pdf" },
    ], download: async () => new Response("abc") } as unknown as ShufflrrClient;
    const log = collectLog();
    const result = await performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, log);
    assert.equal(result.failedFiles, 1);
    assert.equal(result.summary.copiedFiles, 1);
    assert.equal(log.events.find(row => row.path === "Source/later.pdf")?.status, "copied");
    assert.ok(!fixture.rows().some(row => row.sourceId === String(sourceFile.id)));
  }
});

test("shared and unknown transfer failures stop later files without undoing verified earlier deletions", async () => {
  for (const error of [
    new AccessError("Denied", "Denied", 403),
    new FileTransferError("Upload denied", 401),
    new FileTransferError("Upload denied", 403),
    new ProviderBackoffError("SharePoint", new Date(Date.now() + 60_000)),
    new Error("database unavailable"),
    new TypeError("fetch failed"),
  ]) {
    const fixture = engineFixture([
      { ...mapping(1, "99", "stale", false), relativePath: "Source/gone.pdf" },
    ], [{ ...item("stale", "gone.pdf", "root"), path: "Source/gone.pdf" }]);
    fixture.providers.uploadSyncFile = async () => { throw error; };
    const client = { folder: async () => sourceRoot, contents: async () => [
      sourceFile, { ...sourceFile, id: 6, name: "later.pdf" },
    ], download: async () => new Response("abc") } as unknown as ShufflrrClient;
    const log = collectLog();
    await assert.rejects(performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, log));
    assert.equal(log.events.find(row => row.path === "Source/later.pdf")?.status, "skipped");
    assert.equal(fixture.calls[0], "delete:stale");
    assert.equal(log.summary?.deletedItems, 1);
  }
});

test("folder prerequisite failures still stop the run", async () => {
  const fixture = engineFixture();
  fixture.providers.createSyncFolder = async () => { throw new AccessError("InvalidName", "Invalid name", 400); };
  const log = collectLog();
  await assert.rejects(performSync(fixture.database, sourceClient(true), engineConfig, () => {}, fixture.providers, log));
  assert.equal(log.events[0].itemType, "folder");
  assert.equal(log.events[0].status, "failed");
  assert.ok(!fixture.calls.some(call => call.startsWith("upload:")));
});

test("only explicitly local errors qualify for continuation", () => {
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    assert.equal(canContinueAfterFileError(new FileTransferError("Upload failed", status)), false);
    assert.equal(canContinueAfterFileError(new AccessError("GraphError", "Graph error", status)), false);
  }
  assert.equal(canContinueAfterFileError(new Error("unknown")), false);
  assert.equal(canContinueAfterFileError(new FileTransferError("Unconfirmed upload")), true);
  assert.equal(canContinueAfterFileError(new ShufflrrError("http", "Not found", undefined, 404)), true);
  assert.equal(canContinueAfterFileError(new ShufflrrError("network", "Disconnected")), false);
  assert.equal(canContinueAfterFileError(new ShufflrrError("authentication", "Expired")), false);
});

test("pause saves during an active run without taking its advisory lock; Start is due immediately", async () => {
  const nextRunAt = new Date(Date.now() + 60_000);
  const config = { ...engineConfig, enabled: true, nextRunAt, lastRunStatus: "running" };
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    execute: () => { throw new Error("Control changes must not take the worker's advisory lock"); },
    select: () => ({ from: () => ({ where: () => ({ limit: () => ({
      for: async (mode: string) => { assert.equal(mode, "update"); return [config]; },
    }) }) }) }),
    insert: () => ({ values: () => ({
      onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
        updates.push(set);
        config.enabled = Boolean(set.enabled);
      },
    }) }),
  };
  const db = { transaction: async (action: (value: unknown) => Promise<void>) => action(tx) } as unknown as typeof import("@workspace/db")["db"];
  await setSyncEnabledState(db, false);
  assert.equal(config.enabled, false);
  assert.equal(updates[0].nextRunAt, nextRunAt);
  await setSyncEnabledState(db, true);
  assert.equal(config.enabled, true);
  const scheduled = new PgDialect().sqlToQuery(updates[1].nextRunAt as SQL);
  assert.match(scheduled.sql, /greatest\(now\(\), coalesce/);
  assert.match(scheduled.sql, /provider_retry_at/);
  await setSyncEnabledState(db, true);
  assert.equal(updates[2].nextRunAt, nextRunAt, "Repeated Start must not bypass the current schedule");
});

test("a persisted pause stops automatic work, but not explicitly requested targeted retries", async () => {
  let checks = 0;
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => {
    checks++; return [{ enabled: false }];
  } }) }) }) } as unknown as typeof import("@workspace/db")["db"];
  await assert.rejects(syncPauseCheckpoint(db, false)(), SyncPauseRequested);
  assert.equal(checks, 1);
  await syncPauseCheckpoint(db, true)();
  assert.equal(checks, 1, "Targeted retries are explicitly allowed while automatic sync is paused");
});

test("pause during a transfer finishes the file and prevents later transfers after deletion-first cleanup", async () => {
  const stale = { ...mapping(2, "99", "stale", false), relativePath: "Source/gone.pdf" };
  const fixture = engineFixture([stale], [{ ...item("stale", "gone.pdf", "root"), path: "Source/gone.pdf" }]);
  let paused = false;
  const upload = fixture.providers.uploadSyncFile;
  fixture.providers.uploadSyncFile = async (...args) => {
    const saved = await upload(...args);
    paused = true; // User clicked Pause while this transfer was in flight.
    return saved;
  };
  const client = { folder: async () => sourceRoot, contents: async () => [
    sourceFile, { ...sourceFile, id: 6, name: "later.pdf" },
  ], download: async () => new Response("abc") } as unknown as ShufflrrClient;
  const log = collectLog();
  await assert.rejects(performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, log,
    async () => { if (paused) throw new SyncPauseRequested(); }), SyncPauseRequested);
  assert.equal(log.events.find(event => event.path === "Source/deck.pptx")?.status, "copied");
  assert.ok(fixture.rows().some(row => row.sourceId === "3"), "Completed file retains its mapping");
  assert.equal(fixture.calls[0], "delete:stale");
  assert.ok(!fixture.calls.some(call => call.includes("later.pdf")));
  assert.ok(!log.events.some(event => event.status === "failed"));
});

test("pause before listing makes no provider calls", async () => {
  const fixture = engineFixture();
  const client = { folder: async () => { assert.fail("Paused sync must not request a source folder"); } } as unknown as ShufflrrClient;
  await assert.rejects(performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, collectLog(),
    async () => { throw new SyncPauseRequested(); }), SyncPauseRequested);
  assert.deepEqual(fixture.calls, []);
});

test("pausing between deletions prevents deleting the next managed item", async () => {
  const fixture = engineFixture([
    mapping(1, "1", "d-root", true),
    { ...mapping(2, "98", "d-first", false), relativePath: "Source/first.pdf" },
    { ...mapping(3, "99", "d-second", false), relativePath: "Source/second.pdf" },
  ], [
    { ...item("d-root", "Source", "root", true), path: "Source" },
    { ...item("d-first", "first.pdf", "d-root"), path: "Source/first.pdf" },
    { ...item("d-second", "second.pdf", "d-root"), path: "Source/second.pdf" },
  ]);
  let paused = false;
  const remove = fixture.providers.deleteSyncItem;
  fixture.providers.deleteSyncItem = async id => { await remove(id); paused = true; };
  const client = { folder: async () => sourceRoot, contents: async () => [] } as unknown as ShufflrrClient;
  await assert.rejects(performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, collectLog(),
    async () => { if (paused) throw new SyncPauseRequested(); }), SyncPauseRequested);
  assert.ok(fixture.calls.includes("delete:d-first"));
  assert.ok(!fixture.calls.includes("delete:d-second"));
});

test("a source file removed during download does not block independent verified deletions or later uploads", async () => {
  const stale = { ...mapping(1, "99", "stale", false), relativePath: "Source/gone.pdf" };
  const fixture = engineFixture([stale], [{ ...item("stale", "gone.pdf", "root"), path: "Source/gone.pdf" }]);
  const client = {
    folder: async () => sourceRoot,
    contents: async () => [sourceFile, { ...sourceFile, id: 6, name: "later.pdf" }],
    download: async (id: number) => {
      if (id === sourceFile.id) throw new ShufflrrError("http", "Missing", undefined, 404);
      return new Response("abc");
    },
  } as unknown as ShufflrrClient;
  const log = collectLog();
  const result = await performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, log);
  assert.equal(result.failedFiles, 1);
  assert.equal(result.summary.copiedFiles, 1);
  assert.equal(log.events.find(row => row.path === "Source/later.pdf")?.status, "copied");
  assert.equal(fixture.calls[0], "delete:stale");
  assert.ok(!fixture.rows().some(row => row.destinationId === "stale"));
});

test("an incomplete nested source listing prevents all deletions and transfers", async () => {
  const fixture = engineFixture([mapping(1, "99", "stale", false)], [
    { ...item("stale", "gone.pdf", "root"), path: "Source/gone.pdf" },
  ]);
  const client = {
    folder: async () => sourceRoot,
    contents: async (id: number) => {
      if (id === 1) return [{ id: 2, name: "Nested", isFolder: true }];
      throw new ShufflrrError("http", "Unavailable", undefined, 403);
    },
  } as unknown as ShufflrrClient;
  await assert.rejects(performSync(fixture.database, client, engineConfig, () => {}, fixture.providers));
  assert.deepEqual(fixture.calls, []);
  assert.ok(fixture.rows().some(row => row.destinationId === "stale"));
});

test("an inaccessible selected source root cannot be treated as an empty folder", async () => {
  for (const status of [401, 404, 429, 503]) {
    const fixture = engineFixture([mapping(1, "99", "stale", false)], [
      { ...item("stale", "gone.pdf", "root"), path: "Source/gone.pdf" },
    ]);
    const client = { folder: async () => {
      throw new ShufflrrError("http", "Unavailable", undefined, status);
    } } as unknown as ShufflrrClient;
    await assert.rejects(performSync(fixture.database, client, engineConfig, () => {}, fixture.providers));
    assert.deepEqual(fixture.calls, []);
  }
});

test("a restored source file is kept even if its next upload fails", async () => {
  const fixture = engineFixture([mapping(1, "1", "d-root", true), mapping(2, "3", "d-file", false)], [
    { ...item("d-root", "Source", "root", true), path: "Source" },
    { ...item("d-file", "deck.pptx", "d-root"), path: "Source/deck.pptx" },
  ]);
  fixture.providers.uploadSyncFile = async () => { throw new FileTransferError("File exceeds upload limit"); };
  const result = await performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers);
  assert.equal(result.failedFiles, 1);
  assert.equal(result.summary.deletedItems, 0);
  assert.ok(!fixture.calls.some(call => call.startsWith("delete:")));
});

test("a stale folder with a live child is retained until the child has moved safely", async () => {
  const fixture = engineFixture([
    mapping(1, "1", "d-root", true),
    { ...mapping(2, "7", "d-gone", true), sourceParentId: "1", relativePath: "Source/Gone" },
    { ...mapping(3, "3", "d-file", false), sourceParentId: "7", relativePath: "Source/Gone/deck.pptx" },
  ], [
    { ...item("d-root", "Source", "root", true), path: "Source" },
    { ...item("d-gone", "Gone", "d-root", true), path: "Source/Gone" },
    { ...item("d-file", "deck.pptx", "d-gone"), path: "Source/Gone/deck.pptx" },
  ]);
  const log = collectLog();
  await performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers, log);
  assert.ok(!fixture.calls.some(call => call.startsWith("delete:")));
  assert.ok(fixture.calls.includes("move:d-file"));
  assert.match(log.events.find(event => event.path === "Source/Gone")?.message ?? "", /still-live/);
  const next = engineFixture(fixture.rows(), [
    { ...item("d-root", "Source", "root", true), path: "Source" },
    { ...item("d-gone", "Gone", "d-root", true), path: "Source/Gone" },
    { ...item("d-file", "deck.pptx", "d-root"), cTag: "new-tag", path: "Source/deck.pptx" },
  ]);
  await performSync(next.database, sourceClient(), engineConfig, () => {}, next.providers);
  assert.deepEqual(next.calls, ["delete:d-gone"], "The now-empty old parent is deleted on the next full run");
});

test("a stale folder cascades once and records deleted descendants regardless of mapping order", async () => {
  const fixture = engineFixture([
    { ...mapping(2, "8", "d-child", false), sourceParentId: "7", relativePath: "Source/Gone/child.pdf" },
    { ...mapping(3, "7", "d-gone", true), sourceParentId: "1", relativePath: "Source/Gone" },
    mapping(1, "1", "d-root", true),
  ], [
    { ...item("d-root", "Source", "root", true), path: "Source" },
    { ...item("d-gone", "Gone", "d-root", true), path: "Source/Gone" },
    { ...item("d-child", "child.pdf", "d-gone"), path: "Source/Gone/child.pdf" },
  ]);
  const client = { folder: async () => sourceRoot, contents: async () => [] } as unknown as ShufflrrClient;
  const log = collectLog();
  await performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, log);
  assert.deepEqual(fixture.calls, ["delete:d-gone"]);
  assert.equal(log.events.find(event => event.path === "Source/Gone/child.pdf")?.status, "deleted");
  assert.deepEqual(fixture.rows().map(row => row.destinationId), ["d-root"]);
});

test("stale files moved out of a stale destination folder are deleted separately using actual ancestry", async () => {
  const fixture = engineFixture([
    mapping(1, "1", "d-root", true),
    { ...mapping(2, "7", "d-gone", true), sourceParentId: "1", relativePath: "Source/Gone" },
    { ...mapping(3, "8", "d-child", false), sourceParentId: "7", relativePath: "Source/Gone/child.pdf" },
  ], [
    { ...item("d-root", "Source", "root", true), path: "Source" },
    { ...item("d-gone", "Gone", "d-root", true), path: "Source/Gone" },
    { ...item("d-child", "child.pdf", "d-root"), path: "Source/child.pdf" },
  ]);
  const client = { folder: async () => sourceRoot, contents: async () => [] } as unknown as ShufflrrClient;
  await performSync(fixture.database, client, engineConfig, () => {}, fixture.providers);
  assert.deepEqual(fixture.calls, ["delete:d-gone", "delete:d-child"]);
});

test("a deletion failure is logged and stops the run before any file transfer", async () => {
  const fixture = engineFixture([mapping(1, "99", "stale", false)], [
    { ...item("stale", "gone.pdf", "root"), path: "Source/gone.pdf" },
  ]);
  fixture.providers.deleteSyncItem = async id => {
    fixture.calls.push(`delete:${id}`);
    throw new AccessError("Denied", "Deletion denied", 403);
  };
  const log = collectLog();
  await assert.rejects(performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers, log));
  assert.deepEqual(fixture.calls, ["delete:stale"]);
  assert.equal(log.events.find(event => event.status === "failed")?.itemType, "file");
  assert.ok(fixture.rows().some(row => row.destinationId === "stale"));
});

test("retry-all queues across pages atomically, preserves cooldowns and refuses overlapping runs", async () => {
  let locked = true;
  let count = 65;
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const cooldown = new Date(Date.now() + 60_000);
  const config = {
    ...engineConfig, excludedFolders: [exclusion], providerRetryAt: cooldown, lastRunStatus: "partial",
  };
  const fakeDb = {
    transaction: async (action: (tx: unknown) => Promise<unknown>) => action({
      select: () => ({ from: () => ({ where: async () => [config] }) }),
      execute: async (query: SQL) => {
        const statement = new PgDialect().sqlToQuery(query);
        statements.push(statement);
        if (statement.sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked }] };
        const queuedCount = count;
        count = 0;
        return { rows: [{ count: queuedCount }] };
      },
      update: () => ({ set: () => ({ where: () => ({
        returning: async () => [],
      }) }) }),
    }),
    update: () => ({ set: () => ({
      where: (condition: SQL) => {
        statements.push(new PgDialect().sqlToQuery(condition));
        return { returning: async () => [{ id: 1 }, { id: 2 }, { id: 3 }] };
      },
    }) }),
  } as unknown as typeof import("@workspace/db")["db"];
  const app = express();
  app.use("/failures", syncFailureRoutes((_req, res, error) => {
    res.status(error instanceof AccessError ? error.status : 500).end();
  }, async () => fakeDb));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.on("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/failures/retry-all`;
    const first = await fetch(url, { method: "POST" });
    assert.equal(first.status, 202);
    const accepted = RetryAllSyncFilesResponse.parse(await first.json());
    assert.equal(accepted.queuedCount, 65);
    assert.equal(accepted.clearedCount, 65);
    assert.equal(accepted.retryAt.toISOString(), cooldown.toISOString());
    assert.ok(accepted.queuedAt && Number.isFinite(accepted.queuedAt.getTime()));
    const update = statements.find(statement => statement.sql.includes("UPDATE"))!;
    assert.match(update.sql, /resolved_at.*is null/i);
    assert.match(update.sql, /dismissed_at.*is null/i);
    assert.match(update.sql, /retry_requested_at.*is null/i);
    assert.match(update.sql, /source_root_id/);
    assert.match(update.sql, /destination_root_id/);
    assert.match(update.sql, /ancestor_ids.*@>/);
    assert.doesNotMatch(update.sql, /limit/i);
    assert.ok(update.params.includes(engineConfig.destinationFolderId));
    assert.ok(update.params.includes(JSON.stringify([exclusion.id])));
    const repeated = await fetch(url, { method: "POST" });
    assert.equal(repeated.status, 202);
    assert.equal(RetryAllSyncFilesResponse.parse(await repeated.json()).queuedCount, 0);
    const clearAll = await fetch(`http://127.0.0.1:${address.port}/failures/dismiss-all`, { method: "POST" });
    assert.equal(clearAll.status, 200);
    assert.equal(DismissAllSyncFailuresResponse.parse(await clearAll.json()).clearedCount, 3);
    const clearFilter = statements.at(-1)!;
    assert.match(clearFilter.sql, /resolved_at.*is null/i);
    assert.match(clearFilter.sql, /dismissed_at.*is null/i);
    locked = false;
    const before = statements.length;
    const blocked = await fetch(url, { method: "POST" });
    assert.equal(blocked.status, 409);
    assert.equal(statements.length, before + 1, "Lock refusal must prevent the queue update");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("SharePoint-only items are logged as destination conflicts, not invented source files", async () => {
  const fixture = engineFixture([], [{ ...item("extra", "extra.txt", "root"), path: "extra.txt" }]);
  const log = collectLog();
  await performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers, log);
  const extra = log.events.find(event => event.destinationPath === "Shared Documents/extra.txt");
  assert.equal(extra?.status, "conflict");
  assert.equal(extra?.path, null);
});

test("mapped files report updated and later unchanged outcomes accurately", async () => {
  const seed = [mapping(1, "1", "dest-folder", true), mapping(2, "3", "dest-file", false)];
  const records = [
    { ...item("dest-folder", "Source", "root", true), path: "Source" },
    { ...item("dest-file", "deck.pptx", "dest-folder"), cTag: "old-tag", path: "Source/deck.pptx" },
  ];
  const fixture = engineFixture(seed, records);
  const log = collectLog();
  await performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers, log);
  assert.deepEqual(log.events.map(row => row.status), ["unchanged", "updated"]);
});

test("Office processing retains original source size and does not cause repeated uploads", async () => {
  const records = [
    { ...item("dest-folder", "Source", "root", true), path: "Source" },
    { ...item("dest-file", "deck.pptx", "dest-folder"), cTag: "old-tag", path: "Source/deck.pptx" },
  ];
  const fixture = engineFixture(
    [mapping(1, "1", "dest-folder", true), mapping(2, "3", "dest-file", false)], records);
  let uploads = 0;
  fixture.providers.uploadSyncFile = async () => {
    uploads++;
    return {
      ...item("dest-file", "deck.pptx", "dest-folder"), size: 9, cTag: "office-tag",
      uploadNote: uploadSizeNote(3, 9),
    };
  };
  const firstLog = collectLog();
  await performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers, firstLog);
  assert.equal(fixture.rows().find(row => row.sourceId === "3")?.sourceSize, 3);
  assert.match(firstLog.events.find(event => event.status === "updated")?.message ?? "",
    /Source bytes transferred: 3.*SharePoint stored bytes: 9/);

  records[1] = { ...records[1], size: 9, cTag: "office-tag" };
  const secondLog = collectLog();
  await performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers, secondLog);
  assert.equal(uploads, 1);
  assert.equal(secondLog.events.find(event => event.path === "Source/deck.pptx")?.status, "unchanged");

  // A real destination edit must still be restored, independently of the size difference.
  records[1] = { ...records[1], cTag: "manually-edited" };
  await performSync(fixture.database, sourceClient(), engineConfig, () => {}, fixture.providers);
  assert.equal(uploads, 2);
});

test("source deletion logs the managed file deleted from SharePoint", async () => {
  const fixture = engineFixture(
    [mapping(1, "1", "dest-folder", true), mapping(2, "3", "dest-file", false)],
    [
      { ...item("dest-folder", "Source", "root", true), path: "Source" },
      { ...item("dest-file", "deck.pptx", "dest-folder"), path: "Source/deck.pptx" },
    ],
  );
  const client = { folder: async () => sourceRoot, contents: async () => [] } as unknown as ShufflrrClient;
  const log = collectLog();
  const result = await performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, log);
  assert.equal(result.summary.deletedItems, 1);
  assert.equal(log.events.find(row => row.status === "deleted")?.path, "Source/deck.pptx");
  assert.deepEqual(fixture.calls, ["delete:dest-file"]);
});

test("folder rename logs a moved outcome instead of claiming it was unchanged", async () => {
  const fixture = engineFixture([mapping(1, "1", "dest-folder", true)],
    [{ ...item("dest-folder", "Source", "root", true), path: "Source" }]);
  const client = {
    folder: async () => ({ ...sourceRoot, name: "Renamed" }), contents: async () => [],
  } as unknown as ShufflrrClient;
  const log = collectLog();
  await performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, log);
  assert.equal(log.events[0]?.status, "moved");
  assert.equal(log.events[0]?.path, "Renamed");
  assert.deepEqual(fixture.calls, ["move:dest-folder"]);
});
