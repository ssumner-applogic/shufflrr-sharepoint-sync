import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { syncConfigTable, syncFileFailuresTable, syncItemsTable, syncOrphanNoticesTable, type SyncConfig } from "@workspace/db/schema";
import { disconnectSyncFolders, requestSyncNow, setSyncEnabledState } from "./sync-control";
import { AccessError } from "./sharepoint";

type Database = typeof import("@workspace/db")["db"];

test("Sync now rejects an active job with retry-after-completion guidance and never queues work", async () => {
  const f = fixture({ locked: false, enabled: true, running: true });
  await assert.rejects(requestSyncNow(f.database, 12345),
    (error: unknown) => error instanceof AccessError && error.status === 409 &&
      error.code === "SyncRunning" && /finish, then try Sync now again/.test(error.message));
  assert.equal(f.configReads(), 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.config(), f.original);
});

test("Sync now is accepted once the run lock is free and keeps the saved interval", async () => {
  const f = fixture({ locked: true, enabled: true });
  await requestSyncNow(f.database, 12345);
  assert.equal(f.writes.length, 1);
  assert.equal(f.config()?.pollIntervalSeconds, 300);
  assert.equal(f.config()?.enabled, true);
  assert.match(new PgDialect().sqlToQuery(f.writes[0].nextRunAt as SQL).sql, /greatest\(now\(\)/);
});

function fixture(options: {
  locked?: boolean; enabled?: boolean; running?: boolean; absent?: boolean; failNotice?: boolean;
} = {}) {
  let config: SyncConfig | undefined = options.absent ? undefined : {
    id: 1, enabled: options.enabled ?? false,
    destinationFolderId: "previous-target", destinationFolderName: "Original target",
    sourceFolders: [{ id: 10, name: "Root A" }, { id: 20, name: "Root B" }, { id: 30, name: "Never copied" }],
    excludedFolders: [{ id: 11, name: "Excluded", rootId: 10, ancestorIds: [10] }],
    pollIntervalSeconds: 300, nextRunAt: new Date("2026-01-01T12:00:00Z"),
    providerRetryAt: new Date("2026-01-01T12:10:00Z"), updatedAt: new Date("2026-01-01T11:00:00Z"),
    lastRunAt: new Date("2026-01-01T11:00:00Z"), lastRunStatus: options.running ? "running" : "partial",
    lastRunSummary: { copiedFiles: 2, updatedFiles: 1, deletedItems: 0, createdFolders: 2, conflicts: 1 },
    lastRunConflicts: [{ path: "Root A/file.pdf", kind: "path-conflict" }], lastRunError: "Previous safe error",
  };
  const original = structuredClone(config);
  const notices: Array<Record<string, unknown>> = [{ sourceRootId: "10", destinationFolderId: "previous-target" }];
  const queries: string[] = [];
  const writes: Record<string, unknown>[] = [];
  const queueWrites: Record<string, unknown>[] = [];
  let configReads = 0;
  const tx = {
    execute: async (query: SQL) => {
      const compiled = new PgDialect().sqlToQuery(query);
      assert.match(compiled.sql, /pg_try_advisory_xact_lock/);
      assert.deepEqual(compiled.params, [12345]);
      return { rows: [{ locked: options.locked ?? true }] };
    },
    select: () => ({
      from: (table: unknown) => ({
        where: (query: SQL) => {
          queries.push(new PgDialect().sqlToQuery(query).sql);
          if (table === syncConfigTable) {
            configReads++;
            return { limit: () => ({ for: async (mode: string) => {
              assert.equal(mode, "update");
              return config ? [config] : [];
            } }) };
          }
          if (table === syncItemsTable) return Promise.resolve([{ sourceRootId: "10" }, { sourceRootId: "20" }]);
          assert.equal(table, syncOrphanNoticesTable);
          return Promise.resolve(notices);
        },
      }),
    }),
    insert: (table: unknown) => {
      assert.equal(table, syncOrphanNoticesTable, "Only detached notices may be inserted");
      return { values: async (rows: Array<Record<string, unknown>>) => {
        if (options.failNotice) throw new Error("notice insert failed");
        notices.push(...rows);
      } };
    },
    update: (table: unknown) => {
      if (table === syncFileFailuresTable) return {
        set: (values: Record<string, unknown>) => ({ where: async (query: SQL) => {
          assert.deepEqual(values, { retryRequestedAt: null }, "Retain all failure and dismissal details");
          const compiled = new PgDialect().sqlToQuery(query);
          assert.match(compiled.sql, /destination_root_id/);
          assert.match(compiled.sql, /source_root_id/);
          assert.match(compiled.sql, /retry_requested_at.*is not null/);
          assert.deepEqual(compiled.params, ["previous-target", 10, 20, 30]);
          queueWrites.push(values);
        } }),
      };
      assert.equal(table, syncConfigTable, "File mappings and historical records must never be modified");
      return { set: (values: Record<string, unknown>) => ({ where: async () => {
        writes.push(values);
        config = { ...config!, ...values };
      } }) };
    },
    delete: () => { assert.fail("Disconnect must not delete any records"); },
  };
  const database = { transaction: async (action: (value: unknown) => Promise<void>) => {
    const before = structuredClone(config);
    const previousNotices = structuredClone(notices);
    try { await action(tx); }
    catch (error) { config = before; notices.splice(0, notices.length, ...previousNotices); throw error; }
  } } as unknown as Database;
  return { database, original, notices, queries, writes, queueWrites, config: () => config, configReads: () => configReads };
}

test("disconnect clears saved folders but preserves preferences, cooldowns, history, and old file mappings", async () => {
  const f = fixture();
  await disconnectSyncFolders(f.database, 12345);
  const config = f.config()!;
  assert.equal(config.enabled, false);
  assert.equal(config.destinationFolderId, null);
  assert.equal(config.destinationFolderName, null);
  assert.deepEqual(config.sourceFolders, []);
  assert.deepEqual(config.excludedFolders, []);
  assert.equal(config.nextRunAt, null);
  for (const key of ["pollIntervalSeconds", "providerRetryAt", "lastRunAt", "lastRunStatus",
    "lastRunSummary", "lastRunConflicts", "lastRunError"] as const)
    assert.deepEqual(config[key], f.original![key], `${key} must survive disconnect`);
  assert.equal(f.writes.length, 1);
  assert.equal(f.queueWrites.length, 1, "Cancel stale explicit retries so a paused reconnection cannot restart them");
  assert.match(f.queries[1], /destination_root_id/);
  assert.match(f.queries[1], /source_root_id/);
  assert.match(f.queries[1], /source_parent_id.*is null/);
  assert.deepEqual(f.notices, [
    { sourceRootId: "10", destinationFolderId: "previous-target" },
    { sourceRootId: "20", sourceRootName: "Root B", destinationFolderId: "previous-target", destinationFolderName: "Original target" },
  ], "Keep existing notices and add only previously copied roots, without duplicates");
  await disconnectSyncFolders(f.database, 12345);
  assert.equal(f.notices.length, 2, "Repeated disconnect must not duplicate notices");
  assert.equal(f.queueWrites.length, 1);
});

for (const [label, options, expected] of [
  ["worker or explicit retry holds the run lock", { locked: false }, "SyncRunning"],
  ["sync is enabled", { enabled: true }, "SyncEnabled"],
  ["pause is finishing an active run", { running: true }, "SyncRunning"],
] as const) test(`disconnect is rejected when ${label}`, async () => {
  const f = fixture(options);
  await assert.rejects(disconnectSyncFolders(f.database, 12345),
    (error: unknown) => error instanceof AccessError && error.code === expected && error.status === 409);
  assert.deepEqual(f.config(), f.original);
  assert.equal(f.writes.length, 0);
  assert.equal(f.notices.length, 1);
  if (!options.locked && "locked" in options) assert.equal(f.configReads(), 0);
});

test("disconnect with no saved row is idempotent and creates no configuration", async () => {
  const f = fixture({ absent: true });
  await disconnectSyncFolders(f.database, 12345);
  assert.equal(f.config(), undefined);
  assert.equal(f.writes.length, 0);
});

test("notice persistence failure leaves the saved mapping unchanged", async () => {
  const f = fixture({ failNotice: true });
  await assert.rejects(disconnectSyncFolders(f.database, 12345), /notice insert failed/);
  assert.deepEqual(f.config(), f.original);
  assert.equal(f.writes.length, 0);
});

test("Start cannot enable disconnected sync before folders are saved again", async () => {
  const f = fixture();
  await disconnectSyncFolders(f.database, 12345);
  await assert.rejects(setSyncEnabledState(f.database, true),
    (error: unknown) => error instanceof AccessError && error.code === "SyncNotConfigured");
  assert.equal(f.config()?.enabled, false);
});
