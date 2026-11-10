import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderBackoffError, ProviderGate, retryDelay } from "@workspace/shufflrr/http-policy";
import { SetSyncIntervalBody } from "@workspace/api-zod";
import { applyDelta, scopeSnapshot } from "./sharepoint-snapshot";
import type { SyncDriveItem } from "./sharepoint";
import { performSync } from "./sync-runner";
import { syncItemsTable, type SyncItem } from "@workspace/db/schema";
import type { ShufflrrClient } from "@workspace/shufflrr";
import type { SyncConflict, SyncLogEventInput, SyncRunSummary } from "@workspace/db/schema";
import { syncSchedulerDelay } from "./sync-scheduler";
import { GetSyncRunEventsQueryParams } from "@workspace/api-zod";
import { SaveSyncConfigBody } from "@workspace/api-zod";
import { excludedMappingIds, validateFolderExclusions } from "./sync-exclusions";

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

function engineFixture(seed: SyncItem[] = [], records: (SyncDriveItem & { path: string })[] = []) {
  let rows = [...seed];
  let writes = 0;
  const calls: string[] = [];
  const database = {
    select: () => ({ from: () => ({ where: async () => [...rows] }) }),
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
    delete: () => ({ where: async () => {} }),
  } as unknown as typeof import("@workspace/db")["db"];
  let sequence = 0;
  const providers: Parameters<typeof performSync>[4] = {
    loadDestinationSnapshot: async () => ({ root, records, driveId: "test-drive" }),
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
  return { database, providers, calls, writes: () => writes, rows: () => rows };
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
  assert.match(log.events.find(event => event.path === "Source/Gone")?.message ?? "", /would also delete excluded/);
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
  await performSync(fixture.database, client, {
    ...engineConfig, retryTargets: [{ sourceRootId: 1, sourceId: 3 }],
  }, () => {}, fixture.providers);
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

test("an oversized file preserves prior outcomes and names both the failed and unattempted files", async () => {
  const fixture = engineFixture([], [{ ...item("existing", "conflict.txt", "parent"), path: "Source/conflict.txt" }]);
  const client = {
    folder: async () => sourceRoot,
    contents: async () => [
      { id: 4, name: "conflict.txt", isFolder: false },
      sourceFile,
      { id: 5, name: "huge.pptx", isFolder: false },
      { id: 6, name: "later.pdf", isFolder: false },
    ],
    download: async (id: number) => new Response("abc", {
      headers: id === 5 ? { "content-length": String(300_000_001) } : {},
    }),
  } as unknown as ShufflrrClient;
  const log = collectLog();
  await assert.rejects(performSync(fixture.database, client, engineConfig, () => {}, fixture.providers, log), /300 MB/);
  assert.equal(log.summary?.copiedFiles, 1);
  assert.equal(log.summary?.createdFolders, 1);
  assert.equal(log.summary?.conflicts, 1);
  assert.equal(log.conflicts[0]?.path, "Source/conflict.txt");
  assert.equal(log.events.find(row => row.status === "failed")?.path, "Source/huge.pptx");
  assert.match(log.events.find(row => row.status === "failed")!.message, /300 MB/);
  assert.equal(log.events.find(row => row.status === "skipped")?.path, "Source/later.pdf");
  assert.ok(!fixture.calls.some(call => call.startsWith("delete:")));
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
