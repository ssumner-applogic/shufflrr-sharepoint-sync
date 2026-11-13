import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, Database, Loader2, RefreshCw, Search } from "lucide-react";
import {
  getGetFileMetadataQueryKey,
  getGetMetadataEventsQueryKey,
  getGetMetadataStatusQueryKey,
  useGetFileMetadata,
  useGetMetadataEvents,
  useGetMetadataStatus,
  useRequestMetadataRefresh,
  type GetFileMetadataParams,
  type GetMetadataEventsParams,
  type MetadataEventStatus,
  type MetadataRun,
  type SourceMetadata,
} from "@workspace/api-client-react";

const PAGE_SIZE = 25;

const runMeta: Record<MetadataRun["status"], { label: string; tone: string }> = {
  running: { label: "Running", tone: "text-sky-700 bg-sky-500/10 border-sky-600/30" },
  success: { label: "Completed", tone: "text-emerald-700 bg-emerald-500/10 border-emerald-600/30" },
  partial: { label: "Completed with issues", tone: "text-amber-700 bg-amber-500/10 border-amber-600/40" },
  failed: { label: "Run failed", tone: "text-destructive bg-destructive/10 border-destructive/40" },
};
const eventMeta: Record<MetadataEventStatus, { label: string; tone: string }> = {
  refreshed: { label: "Refreshed", tone: "text-emerald-700 bg-emerald-500/10 border-emerald-600/30" },
  unchanged: { label: "Unchanged", tone: "text-muted-foreground bg-muted border-border" },
  failed: { label: "Failed", tone: "text-destructive bg-destructive/10 border-destructive/40" },
  skipped: { label: "Skipped", tone: "text-stone-600 bg-stone-500/10 border-stone-500/30" },
};

function fmt(value: string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return error ? "The request could not be completed." : "";
}
function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${tone}`}>{children}</span>;
}

type FieldDef = { key: keyof SourceMetadata; label: string; kind?: "date" | "bytes" };
const groups: { title: string; note?: string; fields: FieldDef[] }[] = [
  { title: "Common", fields: [
    { key: "name", label: "Name" }, { key: "description", label: "Description" }, { key: "fileType", label: "File type" },
    { key: "extension", label: "Extension" }, { key: "size", label: "Size", kind: "bytes" }, { key: "author", label: "Author" },
    { key: "folderName", label: "Folder" }, { key: "parentFolderId", label: "Parent folder ID" }, { key: "portalId", label: "Portal ID" },
    { key: "id", label: "Shufflrr file ID" }, { key: "source", label: "Source" }, { key: "sourceId", label: "Source ID" },
  ] },
  { title: "Activity in Shufflrr", note: "Who and when inside Shufflrr.", fields: [
    { key: "createdDate", label: "Created", kind: "date" }, { key: "createdByName", label: "Created by" },
    { key: "createdByEmail", label: "Created by email" }, { key: "createdById", label: "Created by ID" },
    { key: "modifiedDate", label: "Modified", kind: "date" }, { key: "modifiedByName", label: "Modified by" },
    { key: "modifiedById", label: "Modified by ID" },
  ] },
  { title: "Original file dates", note: "As reported by the source file.", fields: [
    { key: "fileCreatedDate", label: "File created", kind: "date" }, { key: "fileModifiedDate", label: "File modified", kind: "date" },
  ] },
];

function renderValue(v: unknown, kind?: FieldDef["kind"]) {
  if (v === undefined) return <span className="italic text-muted-foreground/70">Not reported</span>;
  if (v === null || v === "") return <span className="italic text-muted-foreground/70">Not provided</span>;
  if (kind === "date") return fmt(String(v));
  if (kind === "bytes" && typeof v === "number") return `${v.toLocaleString()} bytes`;
  return String(v);
}

function Dl({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function MetadataLookup({ lookup, active }: { lookup: GetFileMetadataParams | null; active: boolean }) {
  const params = lookup ?? { driveId: "", itemId: "" };
  const q = useGetFileMetadata(params, { query: { queryKey: getGetFileMetadataQueryKey(params), enabled: active && !!lookup, retry: false } });
  if (!lookup) return <p className="text-xs text-muted-foreground">Select a logged event or enter a drive ID and item ID to view its source metadata.</p>;
  if (q.isLoading) return <div className="space-y-1.5">{[0, 1, 2, 3].map(i => <div key={i} className="h-4 animate-pulse rounded bg-muted" />)}</div>;
  if (q.isError) return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
      Could not load metadata: {errorText(q.error)}
      <button type="button" className="underline" onClick={() => void q.refetch()} data-testid="button-retry-file-metadata">Retry</button>
    </div>
  );
  const r = q.data;
  if (!r) return null;
  return (
    <div className="space-y-3" data-testid="panel-file-metadata">
      <div className="flex flex-wrap items-center gap-1.5">
        {r.stale && <Badge tone="text-amber-700 bg-amber-500/10 border-amber-600/40">Stale snapshot</Badge>}
        {!r.mapped && <Badge tone="text-stone-600 bg-stone-500/10 border-stone-500/30">Unmapped provenance</Badge>}
        {r.mapped && !r.stale && <Badge tone="text-emerald-700 bg-emerald-500/10 border-emerald-600/30">Current</Badge>}
        <span className="text-[11px] text-muted-foreground">Read-only Shufflrr source values. SharePoint native fields are not changed.</span>
      </div>
      {r.stale && <p className="text-[11px] text-amber-800">The latest refresh attempt did not confirm these values; they may be out of date.</p>}
      {!r.mapped && <p className="text-[11px] text-muted-foreground">This SharePoint item is not linked to a current Shufflrr source mapping; values may come from an earlier association.</p>}
      {r.lastError && <p className="break-words text-xs text-destructive" role="alert">Last error: {r.lastError}</p>}
      {r.fields === null ? (
        <p className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">No source metadata captured for this item yet.</p>
      ) : groups.map(g => (
        <div key={g.title}>
          <h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.title}{g.note && <span className="ml-2 font-normal normal-case tracking-normal">{g.note}</span>}</h5>
          <Dl rows={g.fields.map(f => [f.label, renderValue(r.fields?.[f.key], f.kind)])} />
        </div>
      ))}
      <div>
        <h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">App refresh</h5>
        <Dl rows={[
          ["Observed", r.observedAt ? fmt(r.observedAt) : renderValue(null)],
          ["Last attempt", fmt(r.lastAttemptAt)],
          ["Source file ID", String(r.sourceFileId)],
          ["Drive ID", <span className="break-all font-mono">{r.driveId}</span>],
          ["Item ID", <span className="break-all font-mono">{r.itemId}</span>],
        ]} />
      </div>
    </div>
  );
}

export function SyncMetadataActivity({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [cursors, setCursors] = useState<number[]>([]);
  const [driveId, setDriveId] = useState("");
  const [itemId, setItemId] = useState("");
  const [lookup, setLookup] = useState<GetFileMetadataParams | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const previousRun = useRef<{ id: string; status: MetadataRun["status"] } | null>(null);

  const statusQuery = useGetMetadataStatus({ query: { enabled: active, queryKey: getGetMetadataStatusQueryKey(), refetchInterval: 5000 } });
  const status = statusQuery.data;
  const runs = status?.runs ?? [];
  const latest = runs[0] ?? null;
  const selectedRun = runs.find(r => r.id === runId) ?? null;

  useEffect(() => { if (runId === null && latest) setRunId(latest.id); }, [runId, latest?.id]);
  useEffect(() => { setCursors([]); setSelectedEvent(null); }, [runId]);
  useEffect(() => {
    if (requestedAt && latest && new Date(latest.startedAt) >= new Date(requestedAt)) {
      setRunId(latest.id);
      setRequestedAt(null);
    }
  }, [requestedAt, latest?.id, latest?.startedAt]);
  useEffect(() => {
    if (selectedRun && previousRun.current?.id === selectedRun.id &&
      previousRun.current.status === "running" && selectedRun.status !== "running") {
      void queryClient.invalidateQueries({ queryKey: getGetMetadataEventsQueryKey({ runId: selectedRun.id, limit: PAGE_SIZE }) });
      if (lookup) void queryClient.invalidateQueries({ queryKey: getGetFileMetadataQueryKey(lookup) });
    }
    previousRun.current = selectedRun ? { id: selectedRun.id, status: selectedRun.status } : null;
  }, [selectedRun?.id, selectedRun?.status, queryClient, lookup]);

  const refresh = useRequestMetadataRefresh({
    mutation: { onSuccess: (result) => {
      setRequestedAt(result.requestedAt);
      setOpen(true);
      void queryClient.invalidateQueries({ queryKey: getGetMetadataStatusQueryKey() });
    } },
  });

  const params: GetMetadataEventsParams = { runId: runId ?? "", limit: PAGE_SIZE, ...(cursors.length ? { after: cursors[cursors.length - 1] } : {}) };
  const events = useGetMetadataEvents(params, {
    query: { queryKey: getGetMetadataEventsQueryKey(params), enabled: active && open && !!runId,
      refetchInterval: active && open && selectedRun?.status === "running" ? 3000 : false },
  });
  const page = events.data;

  const running = latest?.status === "running";
  const submitLookup = (e: FormEvent) => {
    e.preventDefault();
    const d = driveId.trim(), i = itemId.trim();
    if (d && i) { setLookup({ driveId: d, itemId: i }); setSelectedEvent(null); }
  };
  const pct = latest && latest.totalFiles > 0 ? Math.min(100, Math.round((latest.processedFiles / latest.totalFiles) * 100)) : 0;

  return (
    <section className="rounded-md border bg-card" aria-labelledby="metadata-activity-heading" data-testid="metadata-activity">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="button-toggle-metadata-activity">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          <Database className="size-4 text-muted-foreground" aria-hidden="true" />
          <span id="metadata-activity-heading" className="text-sm font-medium">Metadata activity</span>
          {latest && <Badge tone={runMeta[latest.status].tone}>{runMeta[latest.status].label}</Badge>}
          {status?.pending && <Badge tone="text-sky-700 bg-sky-500/10 border-sky-600/30">Refresh queued</Badge>}
          <span className="ml-auto truncate text-xs text-muted-foreground" data-testid="text-metadata-last-refresh">
            {statusQuery.isLoading ? "Loading…" : latest?.finishedAt ? `Last refresh ${fmt(latest.finishedAt)}` : latest ? `Started ${fmt(latest.startedAt)}` : "No metadata refresh yet"}
          </span>
        </button>
        <button type="button" onClick={() => refresh.mutate()}
          disabled={!active || !status?.configured || refresh.isPending || status?.pending || running}
          title={!status?.configured ? "Metadata refresh is not configured." : running ? "A metadata refresh is running." : "Refresh source metadata only; no files are transferred."}
          aria-busy={refresh.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="button-refresh-metadata">
          <RefreshCw className={`size-3.5 ${refresh.isPending || running ? "animate-spin" : ""}`} aria-hidden="true" />
          {refresh.isPending ? "Queueing…" : "Refresh metadata"}
        </button>
      </div>

      {refresh.isError && <p className="border-t px-4 py-2 text-xs text-destructive" role="alert">{errorText(refresh.error)}</p>}
      {statusQuery.isError && (
        <div className="flex items-center gap-2 border-t px-4 py-2 text-xs text-destructive" role="alert">
          Could not load metadata status. <button type="button" className="underline" onClick={() => void statusQuery.refetch()} data-testid="button-retry-metadata-status">Retry</button>
        </div>
      )}
      {status && !status.configured && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Metadata refresh is not configured. File sync is unaffected.</p>}
      {status?.pending && !running && <p className="border-t px-4 py-2 text-xs text-muted-foreground" role="status">
        Refresh queued. The independent worker will start it after any active file sync or provider cooldown.
        {(!status.workerLastSeenAt || Date.now() - new Date(status.workerLastSeenAt).getTime() > 30_000) &&
          " The metadata worker has not checked in recently; it may need to be started."}
      </p>}

      {latest && (
        <div className="space-y-1.5 border-t px-4 py-2.5 text-xs" data-testid="metadata-latest-run">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground tabular-nums">
            <span>{latest.processedFiles} / {latest.totalFiles} processed</span>
            <span className="text-emerald-700">{latest.refreshedFiles} refreshed</span>
            <span>{latest.unchangedFiles} unchanged</span>
            <span className={latest.failedFiles ? "text-destructive" : ""}>{latest.failedFiles} failed</span>
            <span>{latest.skippedFiles} skipped</span>
            {latest.sampleLimit != null && <span>Sample limit {latest.sampleLimit}</span>}
            <span className="ml-auto">Every {Math.round((status?.intervalSeconds ?? 0) / 60)} min{status?.nextCrawlAt ? ` · next ${fmt(status.nextCrawlAt)}` : ""}</span>
          </div>
          {running && (
            <div className="h-1.5 overflow-hidden rounded-full bg-sky-100" role="progressbar" aria-label="Metadata refresh progress"
              aria-valuemin={0} aria-valuemax={latest.totalFiles || 100} aria-valuenow={latest.totalFiles ? latest.processedFiles : undefined}>
              <div className={`h-full rounded-full bg-sky-600 transition-[width] duration-300 ${latest.totalFiles ? "" : "w-1/3 animate-pulse"}`}
                style={latest.totalFiles ? { width: `${pct}%` } : undefined} />
            </div>
          )}
          {latest.error && <p className="break-words text-destructive" role="alert">{latest.error}</p>}
          <p className="text-[11px] text-muted-foreground/80">Metadata counts are separate from file sync totals. Worker last seen {status?.workerLastSeenAt ? fmt(status.workerLastSeenAt) : "never"}.</p>
        </div>
      )}

      {open && (
        <div className="grid gap-4 border-t px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-2">
            {statusQuery.isLoading ? <div className="h-8 animate-pulse rounded bg-muted" />
              : runs.length === 0 ? <p className="text-xs text-muted-foreground" data-testid="text-no-metadata-runs">No metadata runs yet. Use Refresh metadata to start one.</p>
              : (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Run
                  <select value={runId ?? ""} onChange={e => setRunId(e.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-md border bg-card px-2 text-xs text-foreground" data-testid="select-metadata-run">
                    {runs.map(r => <option key={r.id} value={r.id}>{fmt(r.startedAt)} — {runMeta[r.status].label}</option>)}
                  </select>
                </label>
              )}
            {runId && !selectedRun && runs.length > 0 && <p className="text-xs text-muted-foreground">This run is no longer retained.</p>}
            {runId && (
              <>
                <div className="max-h-80 overflow-y-auto overscroll-contain rounded border [scrollbar-gutter:stable]" data-testid="list-metadata-events">
                  {events.isError ? (
                    <div className="flex items-center gap-2 p-3 text-xs text-destructive" role="alert">
                      Could not load metadata events. <button type="button" className="underline" onClick={() => void events.refetch()} data-testid="button-retry-metadata-events">Retry</button>
                    </div>
                  ) : events.isLoading ? (
                    <div className="space-y-2 p-3">{[0, 1, 2].map(i => <div key={i} className="h-8 animate-pulse rounded bg-muted" />)}</div>
                  ) : !page?.events.length ? (
                    <p className="p-3 text-xs text-muted-foreground">{selectedRun?.status === "running" ? "Waiting for the first entries…" : "This run logged no metadata entries."}</p>
                  ) : (
                    <ul className="divide-y">
                      {page.events.map(ev => (
                        <li key={ev.id}>
                          <button type="button" aria-pressed={selectedEvent === ev.id}
                            onClick={() => { setSelectedEvent(ev.id); setDriveId(ev.driveId); setItemId(ev.itemId); setLookup({ driveId: ev.driveId, itemId: ev.itemId }); }}
                            className={`grid w-full gap-0.5 px-3 py-2 text-left text-xs transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selectedEvent === ev.id ? "bg-accent/60" : ""}`}
                            data-testid={`row-metadata-event-${ev.id}`}>
                            <span className="flex min-w-0 items-center gap-2">
                              <Badge tone={eventMeta[ev.status].tone}>{eventMeta[ev.status].label}</Badge>
                              <span className="truncate font-medium">{ev.name}</span>
                            </span>
                            {ev.message && <span className="break-words text-muted-foreground">{ev.message}</span>}
                            <span className="text-[11px] text-muted-foreground/80">{fmt(ev.occurredAt)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Page {cursors.length + 1}{events.isFetching && !events.isLoading ? " · updating" : ""}</span>
                  <div className="flex gap-1">
                    <button type="button" disabled={!cursors.length} onClick={() => setCursors(c => c.slice(0, -1))}
                      className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-secondary disabled:opacity-40" data-testid="button-metadata-events-prev">
                      <ChevronLeft className="size-3.5" />Previous</button>
                    <button type="button" disabled={page?.nextAfter == null || events.isFetching}
                      onClick={() => { const n = page?.nextAfter; if (n != null) setCursors(c => [...c, n]); }}
                      className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-secondary disabled:opacity-40" data-testid="button-metadata-events-next">
                      Next<ChevronRight className="size-3.5" /></button>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="min-w-0 space-y-3">
            <form onSubmit={submitLookup} className="flex flex-wrap items-end gap-2" aria-label="Look up source metadata">
              <label className="flex min-w-[8rem] flex-1 flex-col gap-1 text-[11px] text-muted-foreground">Drive ID
                <input value={driveId} onChange={e => setDriveId(e.target.value)} maxLength={500}
                  className="h-8 rounded-md border bg-background px-2 font-mono text-xs text-foreground" data-testid="input-metadata-drive-id" />
              </label>
              <label className="flex min-w-[8rem] flex-1 flex-col gap-1 text-[11px] text-muted-foreground">Item ID
                <input value={itemId} onChange={e => setItemId(e.target.value)} maxLength={500}
                  className="h-8 rounded-md border bg-background px-2 font-mono text-xs text-foreground" data-testid="input-metadata-item-id" />
              </label>
              <button type="submit" disabled={!driveId.trim() || !itemId.trim()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="button-lookup-metadata">
                <Search className="size-3.5" aria-hidden="true" />Look up
              </button>
            </form>
            <div className="rise" key={lookup ? `${lookup.driveId}:${lookup.itemId}` : "none"}>
              <MetadataLookup lookup={lookup} active={active} />
            </div>
          </div>
        </div>
      )}
      {refresh.isPending && <Loader2 className="sr-only" aria-label="Queueing metadata refresh" />}
    </section>
  );
}
