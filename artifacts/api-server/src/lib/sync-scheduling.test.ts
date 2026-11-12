import { test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { syncConfigTable } from "@workspace/db/schema";
import { nextSyncAfterCompletion, preserveSyncControlTimestamp } from "./sync-scheduling";
import { createSyncRunGate } from "./sync-run-gate";

test("marking a run running preserves the user control timestamp instead of invoking onUpdate", () => {
  const query = drizzle.mock().update(syncConfigTable).set({
    lastRunStatus: "running", updatedAt: preserveSyncControlTimestamp(),
  }).toSQL();
  assert.match(query.sql, /"updated_at" = "sync_config"\."updated_at"/);
  assert.deepEqual(query.params, ["running"]);
});

test("completion preserves the control timestamp and evaluates the saved interval in the database", () => {
  const captured = new Date("2026-01-01T00:00:00Z");
  const query = drizzle.mock().update(syncConfigTable).set({
    updatedAt: preserveSyncControlTimestamp(),
    nextRunAt: nextSyncAfterCompletion(captured),
  }).toSQL();
  assert.match(query.sql, /"updated_at" = "sync_config"\."updated_at"/);
  assert.match(query.sql, /"poll_interval_seconds" \* interval '1 second'/);
  assert.match(query.sql, /date_trunc\('milliseconds', "sync_config"\."updated_at"\)/);
  assert.ok(query.params.some(value => value instanceof Date && value.getTime() === captured.getTime()));
});

test("completion without captured controls still schedules an interval and respects provider cooldown", () => {
  const cooldown = new Date("2026-01-01T01:00:00Z");
  const query = drizzle.mock().update(syncConfigTable).set({
    nextRunAt: nextSyncAfterCompletion(undefined, cooldown), updatedAt: preserveSyncControlTimestamp(),
  }).toSQL();
  assert.doesNotMatch(query.sql, /case when/);
  assert.match(query.sql, /greatest\(now\(\) \+/);
  assert.ok(query.params.some(value => value instanceof Date && value.getTime() === cooldown.getTime()));
});

test("concurrent callers in one Preview process cannot enter a second sync", async () => {
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let started = 0;
  const run = createSyncRunGate(async () => { started++; await waiting; return { skipped: false }; }, () => ({ skipped: true }));
  const first = run();
  assert.deepEqual(await run(), { skipped: true });
  assert.deepEqual(await run(), { skipped: true });
  assert.equal(started, 1);
  finish();
  assert.deepEqual(await first, { skipped: false });
  assert.deepEqual(await run(), { skipped: false });
  assert.equal(started, 2);
});

test("an unexpected sync exception releases the local run guard", async () => {
  let attempts = 0;
  const run = createSyncRunGate(async () => {
    if (++attempts === 1) throw new Error("Synthetic failure");
    return { skipped: false };
  }, () => ({ skipped: true }));
  await assert.rejects(run(), /Synthetic failure/);
  assert.deepEqual(await run(), { skipped: false });
});
