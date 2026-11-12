import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { selectActivityRun, selectRunningActivityRun, selectRequestedRetryRun, selectLatestFileTransferRun } from "./activity-selection";
import { ChevronDown, ChevronLeft, ChevronRight, History, Loader2 } from "lucide-react";
import {
  getGetSyncRunEventsQueryKey,
  getGetSyncRunsQueryKey,
  useGetSyncRunEvents,
  useGetSyncRuns,
  type GetSyncRunEventsParams,
  type SyncConfig,
  type SyncEventStatus,
  type SyncLogEntry,
  type SyncRun,
} from "@workspace/api-client-react";

const PAGE_SIZE = 50;

const statusMeta: Record<SyncEventStatus, { label: string; filterLabel?: string; tone: string }> = {
  copied: { label: "File created", filterLabel: "Files created", tone: "text-emerald-700 bg-emerald-500/10 border-emerald-600/30" },
  updated: { label: "Updated", tone: "text-sky-700 bg-sky-500/10 border-sky-600/30" },
  created: { label: "Folders created", tone: "text-teal-700 bg-teal-500/10 border-teal-600/30" },
  moved: { label: "Moved", tone: "text-indigo-700 bg-indigo-500/10 border-indigo-600/30" },
  deleted: { label: "Deleted", tone: "text-orange-700 bg-orange-500/10 border-orange-600/30" },
  unchanged: { label: "Unchanged", tone: "text-muted-foreground bg-muted border-border" },
  conflict: { label: "Conflict", tone: "text-amber-700 bg-amber-500/10 border-amber-600/40" },
  failed: { label: "Failed", tone: "text-destructive bg-destructive/10 border-destructive/40" },
  skipped: { label: "Skipped", tone: "text-stone-600 bg-stone-500/10 border-stone-500/30" },
};
const statusOrder: SyncEventStatus[] = ["copied", "updated", "created", "moved", "deleted", "unchanged", "conflict", "failed", "skipped"];

const runMeta: Record<SyncRun["status"], { label: string; tone: string }> = {
  running: { label: "Running", tone: "text-sky-700 bg-sky-500/10 border-sky-600/30" },
  success: { label: "Completed", tone: "text-emerald-700 bg-emerald-500/10 border-emerald-600/30" },
  partial: { label: "Completed with issues", tone: "text-amber-700 bg-amber-500/10 border-amber-600/40" },
  failed: { label: "Run failed", tone: "text-destructive bg-destructive/10 border-destructive/40" },
};

function fmt(value: string | Date | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function Badge({ tone, children, testId }: { tone: string; children: React.ReactNode; testId?: string }) {
  return <span data-testid={testId} className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${tone}`}>{children}</span>;
}

function EventRow({ entry }: { entry: SyncLogEntry }) {
  const meta = statusMeta[entry.status];
  return (
    <li className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[7.5rem_1fr]" data-testid={`row-sync-event-${entry.id}`}>
      <div className="flex items-start gap-2 sm:flex-col sm:gap-1">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="text-[11px] text-muted-foreground">{entry.itemType}</span>
      </div>
      <div className="min-w-0 space-y-0.5">
        {entry.path && (
          <div className="break-all font-mono text-[12px]"><span className="mr-1 font-sans text-muted-foreground">Source</span>{entry.path}</div>
        )}
        {entry.destinationPath && entry.destinationPath !== entry.path && (
          <div className="break-all font-mono text-[12px]"><span className="mr-1 font-sans text-muted-foreground">Dest</span>{entry.destinationPath}</div>
        )}
        {entry.message && <div className="break-words text-muted-foreground">{entry.message}</div>}
        <div className="text-[11px] text-muted-foreground/80">{fmt(entry.occurredAt)}</div>
      </div>
    </li>
  );
}

function RunningFileProgress({ run }: { run: SyncRun | null }) {
  const progress = run?.summary?.fileProgress;
  const hasTotal = !!progress && Number.isSafeInteger(progress.totalFiles) && progress.totalFiles > 0;
  const processed = progress?.processedFiles ?? 0;
  const total = progress?.totalFiles ?? 0;
  const percent = hasTotal ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  return (
      <div className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-64" data-testid="sync-run-file-progress">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-sky-100"
        role="progressbar"
        aria-label={hasTotal ? `Sync file progress: ${processed} of ${total} files` : "Sync running; waiting for file count"}
        aria-valuemin={0}
        aria-valuemax={hasTotal ? total : 100}
        aria-valuenow={hasTotal ? Math.min(processed, total) : undefined}
      >
        <div
          className={`h-full rounded-full bg-sky-600 transition-[width] duration-300 ${hasTotal ? "" : "w-1/3 animate-pulse"}`}
          style={hasTotal ? { width: `${percent}%` } : undefined}
        />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
        {hasTotal ? `${Math.min(processed, total)} / ${total} files` : "Waiting for file count…"}
      </span>
    </div>
  );
}

function jobLabel(run: SyncRun) {
  return run.summary?.runKind === "retry" ? "Retry failed files"
    : run.summary?.runKind === "full" ? "Full sync" : "Sync";
}

export function SyncActivityLog({ config, active, retryQueuedAt = null, onRetrySelected }: {
  config: SyncConfig; active: boolean;
  retryQueuedAt?: string | null; onRetrySelected?: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(false);
  const [filter, setFilter] = useState<SyncEventStatus | null>(null);
  const [cursors, setCursors] = useState<number[]>([]);

  const runsQuery = useGetSyncRuns({
    query: {
      queryKey: getGetSyncRunsQueryKey(),
      enabled: active,
      refetchInterval: q => active && (retryQueuedAt || config.enabled || q.state.data?.some(r => r.status === "running")) ? 2000 : false,
    },
  });
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const requestedRetry = selectRequestedRetryRun(runs, retryQueuedAt);
  const selectedRun = requestedRetry ?? selectActivityRun(runs, runId, followLatest && !retryQueuedAt);
  const effectiveRunId = selectedRun?.id ?? "";
  useEffect(() => {
    if (!retryQueuedAt) return;
    setFollowLatest(false);
    setOpen(true);
    if (requestedRetry) {
      setRunId(requestedRetry.id);
      setFilter(null);
      onRetrySelected?.();
    }
  }, [retryQueuedAt, requestedRetry?.id, onRetrySelected]);
  useEffect(() => {
    if (selectedRun && (runId === null || followLatest)) setRunId(selectedRun.id);
  }, [selectedRun?.id, runId, followLatest]);
  const previousRun = useRef<{ id: string; status: SyncRun["status"] } | null>(null);
  useEffect(() => {
    const previous = previousRun.current;
    if (selectedRun && previous?.id === selectedRun.id && previous.status === "running" && selectedRun.status !== "running") {
      // Refresh final counts without throwing away the running run's cached entries.
      void queryClient.invalidateQueries({ queryKey: getGetSyncRunEventsQueryKey({ runId: selectedRun.id }) });
    }
    previousRun.current = selectedRun ? { id: selectedRun.id, status: selectedRun.status } : null;
  }, [selectedRun?.id, selectedRun?.status, queryClient]);

  useEffect(() => { setCursors([]); }, [effectiveRunId, filter]);

  const params: GetSyncRunEventsParams = {
    runId: effectiveRunId,
    limit: PAGE_SIZE,
    ...(filter ? { status: filter } : {}),
    ...(cursors.length ? { after: cursors[cursors.length - 1] } : {}),
  };
  const eventsQuery = useGetSyncRunEvents(params, {
    query: {
      queryKey: getGetSyncRunEventsQueryKey(params),
      enabled: active && open && !!effectiveRunId,
      refetchInterval: active && open && selectedRun?.status === "running" ? 1500 : false,
    },
  });
  const page = eventsQuery.data;
  const countMap = new Map((page?.counts ?? []).map(c => [c.status, c.count]));
  const total = [...countMap.values()].reduce((a, b) => a + b, 0);

  const lastRunAt = config.lastRunAt ? new Date(config.lastRunAt).getTime() : null;
  const legacyCovered = lastRunAt !== null && runs.some(r => {
    const s = new Date(r.startedAt).getTime();
    const f = r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now();
    return s <= lastRunAt && lastRunAt <= f;
  });
  const legacy = config.lastRunConflicts.length > 0 && !runsQuery.isLoading && !runsQuery.isError && !legacyCovered
    ? config.lastRunConflicts : [];

  const activeRun = selectRunningActivityRun(runs);
  const latestFileTransfer = selectLatestFileTransferRun(runs);
  // Live execution is independent of the historical run selected for review.
  const runningNow = !!activeRun || config.lastRunStatus === "running";

  return (
    <section className="rounded-md border bg-card" aria-labelledby="sync-activity-heading" data-testid="sync-activity-log">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-secondary/60"
        data-testid="button-toggle-sync-activity"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <History className="size-4 text-muted-foreground" aria-hidden="true" />
        <span id="sync-activity-heading" className="text-sm font-medium">Activity log</span>
        {runningNow
          ? <Badge tone={runMeta.running.tone}>Running</Badge>
          : selectedRun && <Badge tone={runMeta[selectedRun.status].tone}>{runMeta[selectedRun.status].label}</Badge>}
        {runningNow && <Loader2 className="size-3.5 animate-spin text-sky-700" aria-label="Run in progress" />}
        <span className="ml-auto text-xs text-muted-foreground">
          {runsQuery.isLoading ? "Loading runs…" : `${runs.length} run${runs.length === 1 ? "" : "s"} (latest 50 kept)`}
          {legacy.length > 0 && ` · ${legacy.length} legacy item${legacy.length === 1 ? "" : "s"}`}
        </span>
      </button>

      {latestFileTransfer && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs" data-testid="sync-latest-file-change">
          <div>
            <p className="font-medium">Most recent file creation/update: {latestFileTransfer.summary?.copiedFiles ?? 0} files created · {latestFileTransfer.summary?.updatedFiles ?? 0} files updated</p>
            <p className="mt-1 text-muted-foreground">{fmt(latestFileTransfer.finishedAt)} · {runMeta[latestFileTransfer.status].label} · From retained run history; later no-change runs do not replace this result.</p>
          </div>
          <button type="button" className="rounded border px-2 py-1" data-testid="button-view-latest-file-change"
            onClick={() => {
              setRunId(latestFileTransfer.id); setFollowLatest(false); setOpen(true);
              setFilter((latestFileTransfer.summary?.copiedFiles ?? 0) > 0 ? "copied" : "updated");
            }}>
            {(latestFileTransfer.summary?.copiedFiles ?? 0) > 0 ? "View created files" : "View updated files"}
          </button>
        </div>
      )}

      {runningNow && (
        <div className="flex flex-wrap items-center gap-2 border-t bg-sky-50/60 px-4 py-3 text-xs" role="status" data-testid="sync-live-run-status">
          <div className="min-w-0">
            <p className="font-medium text-sky-800">{activeRun ? `${jobLabel(activeRun)} is running.` : "A sync is running."} Wait for it to finish before starting another.</p>
            {activeRun && <p className="mt-1 text-muted-foreground">Started {fmt(activeRun.startedAt)}</p>}
          </div>
          <RunningFileProgress run={activeRun} />
          {activeRun && activeRun.id !== effectiveRunId && (
            <button type="button" className="rounded border bg-card px-2 py-1"
              onClick={() => { setRunId(activeRun.id); setFollowLatest(false); setOpen(true); }}
              data-testid="button-view-running-sync-run">View running run</button>
          )}
        </div>
      )}

      {retryQueuedAt && !requestedRetry && <p role="status" className="border-t px-4 py-3 text-xs text-sky-800" data-testid="sync-retry-waiting">
        Retry failed files queued. Waiting for the worker; provider cooldowns are respected. Results will open here.
      </p>}

      {open && (
        <div className="space-y-3 border-t px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={followLatest} onChange={event => setFollowLatest(event.target.checked)}
                data-testid="checkbox-follow-latest-run" />
              Follow latest run
            </label>
            <span className="text-muted-foreground">{followLatest ? "Switches to each new run; progress restarts for that run." : "Viewing a fixed run; new runs will not reset this log."}</span>
            {!!runs.length && runs[0].id !== effectiveRunId && <button type="button" className="rounded border px-2 py-1"
              onClick={() => { setRunId(runs[0].id); setFollowLatest(false); }}
              data-testid="button-view-latest-sync-run">View latest run</button>}
          </div>
          {!!runId && !selectedRun && <p className="text-xs text-muted-foreground">The selected run is no longer in retained history. Choose View latest run to continue.</p>}
          {runsQuery.isError && (
            <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
              Could not load sync runs.
              <button type="button" className="underline" onClick={() => void runsQuery.refetch()} data-testid="button-retry-sync-runs">Retry</button>
            </div>
          )}
          {runsQuery.isLoading && <div className="h-9 animate-pulse rounded bg-muted" />}

          {!runsQuery.isLoading && !runsQuery.isError && runs.length === 0 && (
            <p className="text-xs text-muted-foreground" data-testid="text-no-sync-runs">
              No logged runs yet. Detailed logs are recorded for runs from now on.
            </p>
          )}

          {selectedRun && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Run
                  <select
                    value={selectedRun.id}
                    onChange={e => { setRunId(e.target.value); setFollowLatest(false); }}
                    className="h-8 max-w-[22rem] rounded-md border bg-card px-2 text-xs text-foreground"
                    data-testid="select-sync-run"
                  >
                    {runs.map(r => (
                      <option key={r.id} value={r.id}>{fmt(r.startedAt)} — {jobLabel(r)} — {runMeta[r.status].label}</option>
                    ))}
                  </select>
                </label>
                <span className="text-xs text-muted-foreground" data-testid="text-sync-run-times">
                  Started {fmt(selectedRun.startedAt)}
                  {selectedRun.finishedAt ? ` · Finished ${fmt(selectedRun.finishedAt)}` : " · In progress"}
                </span>
              </div>
              {!!selectedRun.summary?.archivedFiles && (
                <p className="text-xs text-muted-foreground" data-testid="sync-run-archived-files">
                  {selectedRun.summary.archivedFiles} archived source file{selectedRun.summary.archivedFiles === 1 ? "" : "s"} detected.
                  See Deleted and Skipped entries for archive-policy actions, or Conflict for retained copies.
                </p>
              )}
              {selectedRun.summary?.runKind === "retry" && (
                <p className="text-xs font-medium" role="status" data-testid="sync-retry-result">
                  Retry failed files · {runMeta[selectedRun.status].label}
                  {selectedRun.summary.fileProgress && ` · ${selectedRun.summary.fileProgress.processedFiles} / ${selectedRun.summary.fileProgress.totalFiles} files processed`}
                  {selectedRun.status !== "running" && " · Results kept selected; later scheduled syncs appear separately."}
                </p>
              )}
              {selectedRun.status !== "success" && selectedRun.status !== "running" && (
                <p className="text-xs text-muted-foreground">
                  This run finished but did not complete every item. Items listed as copied, updated or created were still applied.
                </p>
              )}
              {selectedRun.error && <p className="break-words text-xs text-destructive" role="alert">{selectedRun.error}</p>}

              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by outcome">
                <button
                  type="button"
                  onClick={() => setFilter(null)}
                  aria-pressed={filter === null}
                  className={`rounded border px-2 py-1 text-[11px] font-medium ${filter === null ? "border-foreground/50 bg-secondary" : "hover:bg-secondary"}`}
                  data-testid="button-filter-all"
                >
                  All {page ? total : ""}
                </button>
                {statusOrder.map(s => {
                  const n = countMap.get(s) ?? 0;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setFilter(filter === s ? null : s)}
                      aria-pressed={filter === s}
                      className={`rounded border px-2 py-1 text-[11px] font-medium ${statusMeta[s].tone} ${filter === s ? "ring-1 ring-current" : n === 0 ? "opacity-45" : ""}`}
                      data-testid={`button-filter-${s}`}
                    >
                      {statusMeta[s].filterLabel ?? statusMeta[s].label} {page ? n : ""}
                    </button>
                  );
                })}
              </div>

              <div className="max-h-80 overflow-y-auto overscroll-contain rounded border [scrollbar-gutter:stable]" data-testid="list-sync-events">
                {eventsQuery.isError ? (
                  <div className="flex items-center gap-2 p-3 text-sm text-destructive" role="alert">
                    Could not load log entries.
                    <button type="button" className="underline" onClick={() => void eventsQuery.refetch()} data-testid="button-retry-sync-events">Retry</button>
                  </div>
                ) : eventsQuery.isLoading ? (
                  <div className="space-y-2 p-3">{[0, 1, 2].map(i => <div key={i} className="h-8 animate-pulse rounded bg-muted" />)}</div>
                ) : page && page.events.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    {filter ? `No ${statusMeta[filter].label.toLowerCase()} entries in this run.` : selectedRun.status === "running" ? "Waiting for the first entries…" : "This run logged no item entries."}
                  </p>
                ) : (
                  <ul className="divide-y">{page?.events.map(e => <EventRow key={e.id} entry={e} />)}</ul>
                )}
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Page {cursors.length + 1}{eventsQuery.isFetching && !eventsQuery.isLoading ? " · updating" : ""}</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    disabled={!cursors.length}
                    onClick={() => setCursors(c => c.slice(0, -1))}
                    className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-secondary disabled:opacity-40"
                    data-testid="button-sync-events-prev"
                  ><ChevronLeft className="size-3.5" />Previous</button>
                  <button
                    type="button"
                    disabled={page?.nextAfter == null || eventsQuery.isFetching || eventsQuery.isError}
                    onClick={() => { const n = page?.nextAfter; if (n != null) setCursors(c => [...c, n]); }}
                    className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-secondary disabled:opacity-40"
                    data-testid="button-sync-events-next"
                  >Next<ChevronRight className="size-3.5" /></button>
                </div>
              </div>
            </>
          )}

          {legacy.length > 0 && (
            <div className="rounded border border-amber-600/40 bg-amber-500/5 p-3" data-testid="sync-legacy-conflicts">
              <h4 className="text-xs font-medium">Legacy last-run details{config.lastRunAt ? ` (${fmt(config.lastRunAt)})` : ""}</h4>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Recorded before detailed activity logging existed. Only these unchanged items are known for that run.
                {config.lastRunSummary && config.lastRunSummary.conflicts > legacy.length
                  ? ` Showing ${legacy.length} of ${config.lastRunSummary.conflicts} recorded conflicts.` : ""}
              </p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                {legacy.map((c, i) => (
                  <li key={`${c.kind}:${c.path}:${i}`} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <Badge tone={statusMeta.conflict.tone}>{c.kind === "path-conflict" ? "Path already exists" : "SharePoint-only item"}</Badge>
                    <span className="break-all font-mono">{c.path}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
