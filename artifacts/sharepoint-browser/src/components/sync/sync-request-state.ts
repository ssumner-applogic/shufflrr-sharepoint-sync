/** Clear only a busy-job rejection once a fresh server result confirms completion. */
export function shouldClearBusySyncError(
  error: unknown,
  lastRunStatus: string | null | undefined,
  statusFetchedAt: number,
  requestSubmittedAt: number,
): boolean {
  return error instanceof Error && "status" in error && error.status === 409 &&
    error.message.includes("A sync is already running.") &&
    ["success", "partial", "failed"].includes(lastRunStatus ?? "") &&
    statusFetchedAt > requestSubmittedAt;
}
