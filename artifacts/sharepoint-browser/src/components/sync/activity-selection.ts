/** The live job must remain visible even when history is pinned to an older run. */
export function selectRequestedRetryRun<T extends { startedAt: string; summary: { runKind?: string } | null }>(
  runs: T[], queuedAt: string | null,
): T | null {
  if (!queuedAt) return null;
  const requested = Date.parse(queuedAt);
  return runs.filter(run => run.summary?.runKind === "retry" && Date.parse(run.startedAt) >= requested)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0] ?? null;
}

export function selectRunningActivityRun<T extends { status: string }>(runs: T[]): T | null {
  return runs.find(run => run.status === "running") ?? null;
}

/** Later no-change runs must not hide a successful file creation/update. */
export function selectLatestFileTransferRun<T extends {
  status: string; startedAt: string; finishedAt: string | null;
  summary: { copiedFiles: number; updatedFiles: number } | null;
}>(runs: T[]): T | null {
  return runs.filter(run => run.status !== "running" && !!run.finishedAt &&
    ((run.summary?.copiedFiles ?? 0) > 0 || (run.summary?.updatedFiles ?? 0) > 0))
    .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))[0] ?? null;
}

/** Never silently replace a pinned run, including when it leaves retained history. */
export function selectActivityRun<T extends { id: string }>(
  runs: T[],
  selectedId: string | null,
  followLatest: boolean,
): T | null {
  if (followLatest || selectedId === null) return runs[0] ?? null;
  return runs.find(run => run.id === selectedId) ?? null;
}
