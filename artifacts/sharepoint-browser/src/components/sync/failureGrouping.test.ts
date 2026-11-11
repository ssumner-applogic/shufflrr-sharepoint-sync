import assert from "node:assert/strict";
import test from "node:test";
import type { SyncFileFailure } from "@workspace/api-client-react";
import { groupSyncFailures } from "./failureGrouping";

function failure(id: number, latestStatus: SyncFileFailure["latestStatus"]): SyncFileFailure {
  return {
    id, name: `file-${id}.pdf`, path: `Root/file-${id}.pdf`, reason: "Failure reason",
    lastFailedAt: "2026-11-11T16:48:25.000Z", retryRequestedAt: null,
    fileUrl: "https://example.shufflrr.com/file", parentFolderUrl: "https://example.shufflrr.com/folder",
    canRetry: true, issueCount: 1, latestStatus, issues: [],
  };
}

test("groups one fatal file separately from files skipped after it", () => {
  const grouped = groupSyncFailures([
    failure(1, "failed"),
    failure(2, "skipped"),
    failure(3, "skipped"),
  ]);
  assert.deepEqual(grouped.needsAction.map(file => file.id), [1]);
  assert.deepEqual(grouped.notAttempted.map(file => file.id), [2, 3]);
});
