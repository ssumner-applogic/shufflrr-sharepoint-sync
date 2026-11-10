import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderBackoffError, ProviderGate, retryDelay } from "@workspace/shufflrr/http-policy";
import { SetSyncIntervalBody } from "@workspace/api-zod";
import { applyDelta, scopeSnapshot } from "./sharepoint-snapshot";
import type { SyncDriveItem } from "./sharepoint";
import { performSync } from "./sync-runner";
import { syncItemsTable, type SyncItem } from "@workspace/db/schema";
import type { ShufflrrClient } from "@workspace/shufflrr";

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
