import assert from "node:assert/strict";
import test from "node:test";
import { GetSyncRunsResponse } from "@workspace/api-zod";
import { SyncFileProgress } from "./sync-file-progress";

test("progress counts each expected source file once and never exceeds the run total", () => {
  const progress = new SyncFileProgress(["root-1:file-1", "root-2:file-1"]);
  progress.record("root-1:file-1");
  progress.record("root-1:file-1");
  assert.deepEqual(progress.counts, { totalFiles: 2, processedFiles: 1 });
  progress.record("root-2:file-1");
  progress.record("not-in-total");
  assert.deepEqual(progress.counts, { totalFiles: 2, processedFiles: 2 });
});

test("the activity-log API schema preserves live run progress", () => {
  const runs = GetSyncRunsResponse.parse([{
    id: "123e4567-e89b-42d3-a456-426614174000",
    startedAt: "2026-11-12T12:00:00.000Z",
    finishedAt: null,
    status: "running",
    summary: {
      createdFolders: 0, copiedFiles: 1, updatedFiles: 0, deletedItems: 0, conflicts: 0,
      fileProgress: { totalFiles: 10, processedFiles: 4 },
    },
    error: null,
  }]);
  assert.deepEqual(runs[0].summary?.fileProgress, { totalFiles: 10, processedFiles: 4 });
});
