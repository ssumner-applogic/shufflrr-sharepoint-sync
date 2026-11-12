/** The live job must remain visible even when history is pinned to an older run. */
export function selectRunningActivityRun<T extends { status: string }>(runs: T[]): T | null {
  return runs.find(run => run.status === "running") ?? null;
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
