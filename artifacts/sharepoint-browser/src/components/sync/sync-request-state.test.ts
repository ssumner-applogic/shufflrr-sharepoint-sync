import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldClearBusySyncError } from "./sync-request-state";

const busy = Object.assign(new Error("HTTP 409 Conflict: A sync is already running. Wait for it to finish, then try Sync now again."), { status: 409 });

test("a fresh completion clears the old busy warning for every terminal outcome", () => {
  for (const status of ["success", "partial", "failed"])
    assert.equal(shouldClearBusySyncError(busy, status, 200, 100), true);
});

test("a stale completed status cannot hide a new busy rejection", () => {
  assert.equal(shouldClearBusySyncError(busy, "partial", 90, 100), false);
  assert.equal(shouldClearBusySyncError(busy, "partial", 100, 100), false);
});

test("an active or unknown job keeps the busy guidance", () => {
  for (const status of ["running", null, undefined])
    assert.equal(shouldClearBusySyncError(busy, status, 200, 100), false);
});

test("unrelated errors are never cleared by a finished sync", () => {
  const paused = Object.assign(new Error("Start sync before requesting an immediate run."), { status: 409 });
  const failure = Object.assign(new Error(busy.message), { status: 500 });
  for (const error of [paused, failure, null, new Error("Network request failed.")])
    assert.equal(shouldClearBusySyncError(error, "partial", 200, 100), false);
});
