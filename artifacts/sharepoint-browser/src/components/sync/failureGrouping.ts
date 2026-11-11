import type { SyncFileFailure } from "@workspace/api-client-react";

export function groupSyncFailures(failures: SyncFileFailure[]) {
  return {
    needsAction: failures.filter(file => file.latestStatus !== "skipped"),
    notAttempted: failures.filter(file => file.latestStatus === "skipped"),
  };
}
