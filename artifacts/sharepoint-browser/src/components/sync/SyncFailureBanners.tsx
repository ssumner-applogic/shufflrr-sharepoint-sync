import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronDown, ExternalLink, FolderOpen, RefreshCw, X } from "lucide-react";
import {
  dismissSyncFileFailure,
  dismissAllSyncFailures,
  getSyncFailures,
  getGetSyncFailuresQueryKey,
  retrySyncFile,
  retryAllSyncFiles,
  type SyncFileFailure,
} from "@workspace/api-client-react";
import { groupSyncFailures } from "./failureGrouping";
import { SharePointFailureLinks } from "./SharePointFailureLinks";

function FailureItem({ file, compact, retry, dismiss, retryPending, dismissPending, queued }: {
  file: SyncFileFailure;
  compact?: boolean;
  retry: (id: number) => void;
  dismiss: (id: number) => void;
  retryPending: boolean;
  dismissPending: boolean;
  queued?: { id: number; text: string };
}) {
  const showHistory = file.issueCount > 1 && file.issues.length > 0;

  return <div role="alert"
    className={`flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 ${compact ? "p-2" : "p-3"}`}
    data-testid={`sync-failure-${file.id}`}>
    <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <div className="break-all text-sm font-medium">{file.name}</div>
      <div className="break-all text-xs text-muted-foreground">{file.path}</div>
      <p className="mt-1 text-sm text-destructive">{file.reason}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" data-testid={`link-shufflrr-file-${file.id}`}
          className="inline-flex items-center gap-1 underline">
          <ExternalLink className="size-3" aria-hidden="true" />Open file in Shufflrr
        </a>
        <a href={file.parentFolderUrl} target="_blank" rel="noopener noreferrer" data-testid={`link-shufflrr-parent-${file.id}`}
          className="inline-flex items-center gap-1 underline">
          <FolderOpen className="size-3" aria-hidden="true" />Open parent folder in Shufflrr
        </a>
        <SharePointFailureLinks failureId={file.id} />
        <button type="button" data-testid={`button-retry-sync-file-${file.id}`}
          disabled={!file.canRetry || retryPending}
          title={file.retryRequestedAt ? "Retry queued; provider cooldowns are respected."
            : !file.canRetry ? "Wait for the active run to finish, or restore this file to the saved sync scope." : "Retry only this file; no mirror deletions."}
          onClick={() => retry(file.id)}
          className="inline-flex items-center gap-1 font-medium disabled:opacity-50">
          <RefreshCw className={`size-3 ${retryPending ? "animate-spin" : ""}`} aria-hidden="true" />
          {file.retryRequestedAt ? "Retry queued" : "Try again"}
        </button>
        <span className="text-muted-foreground">
          {file.latestStatus === "skipped" ? "Last not attempted" : "Last issue"} {new Date(file.lastFailedAt).toLocaleString()}
        </span>
      </div>
      {file.issueCount === 0 && <p className="mt-2 text-xs text-muted-foreground">
        Detailed issue history starts with new runs; earlier run details are in the Activity log.
      </p>}
      {showHistory && <details className="mt-2 rounded border bg-background/60 p-2 text-xs">
        <summary className="cursor-pointer font-medium">{file.issueCount} recorded issues</summary>
        <ol className="mt-2 space-y-2">
          {file.issues.map((issue, index) => <li key={`${issue.occurredAt}-${index}`} className="border-l-2 pl-2">
            <span className="font-medium capitalize">{issue.status === "failed" ? "Failed" : issue.status}</span>
            <span className="text-muted-foreground"> · {new Date(issue.occurredAt).toLocaleString()}</span>
            <div className="mt-0.5">{issue.reason}</div>
          </li>)}
          {file.issueCount > file.issues.length && <li className="text-muted-foreground">
            Showing the {file.issues.length} most recent issues. Older run details are in the Activity log.
          </li>}
        </ol>
      </details>}
      {queued?.id === file.id && <p className="mt-2 text-xs" role="status">{queued.text}</p>}
    </div>
    <button type="button" data-testid={`button-dismiss-sync-failure-${file.id}`}
      className="shrink-0 rounded p-1 hover:bg-destructive/10"
      aria-label={`Dismiss failure for ${file.name}`} disabled={dismissPending}
      onClick={() => dismiss(file.id)}>
      <X className="size-4" />
    </button>
  </div>;
}

export function SyncFailureBanners({ active }: { active: boolean }) {
  const client = useQueryClient();
  const [after, setAfter] = useState<number | undefined>();
  const [previous, setPrevious] = useState<Array<number | undefined>>([]);
  const [queued, setQueued] = useState<{ id: number; text: string }>();
  const [collapsed, setCollapsed] = useState(false);
  const params = { limit: 20, ...(after ? { after } : {}) };
  const query = useQuery({
    queryKey: getGetSyncFailuresQueryKey(params),
    queryFn: ({ signal }) => getSyncFailures(params, { signal }),
    enabled: active, refetchInterval: active ? 3000 : false,
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: getGetSyncFailuresQueryKey() });
  };
  const dismiss = useMutation({
    mutationFn: (id: number) => dismissSyncFileFailure(id),
    onSuccess: async () => { setAfter(undefined); setPrevious([]); await refresh(); },
  });
  const retry = useMutation({
    mutationFn: (id: number) => retrySyncFile(id),
    onSuccess: async (result, id) => {
      setQueued({ id, text: new Date(result.retryAt).getTime() > Date.now() + 1000
        ? `Retry queued after provider cooldown: ${new Date(result.retryAt).toLocaleString()}.`
        : "Retry queued. The worker will retry this file without enabling automatic sync." });
      await refresh();
    },
  });
  const [bulkMessage, setBulkMessage] = useState("");
  const clearAll = useMutation({
    mutationFn: () => dismissAllSyncFailures(),
    onSuccess: async result => {
      setBulkMessage(`${result.clearedCount} file notice${result.clearedCount === 1 ? "" : "s"} cleared.`);
      setAfter(undefined);
      setPrevious([]);
      await refresh();
    },
  });
  const retryAll = useMutation({
    mutationFn: () => retryAllSyncFiles(),
    onSuccess: async result => {
      const cooldown = new Date(result.retryAt).getTime() > Date.now() + 1000;
      setBulkMessage(`${result.clearedCount} file notice${result.clearedCount === 1 ? "" : "s"} cleared. ` +
        `${result.queuedCount} file${result.queuedCount === 1 ? "" : "s"} queued for retry` +
        (cooldown ? ` after provider cooldown (${new Date(result.retryAt).toLocaleString()})` : "") +
        ". Automatic sync settings are unchanged.");
      setAfter(undefined);
      setPrevious([]);
      await refresh();
    },
  });
  if (!active) return null;
  if (query.isError) return <div className="rounded border p-3 text-sm text-destructive" role="alert">
    File failure notices could not be loaded.
    <button className="ml-2 underline" onClick={() => void query.refetch()}>Retry loading</button>
  </div>;
  const data = query.data;
  if (!data || (!data.total && !retry.error && !dismiss.error && !retryAll.error && !clearAll.error && !bulkMessage)) return null;
  const error = retry.error ?? dismiss.error ?? retryAll.error ?? clearAll.error;
  const { notAttempted: skipped, needsAction } = groupSyncFailures(data.failures);
  const retryFile = (id: number) => { dismiss.reset(); retry.mutate(id); };
  const dismissFile = (id: number) => { retry.reset(); dismiss.mutate(id); };

  return <section className="overflow-hidden rounded-md border bg-card" aria-label="Files needing attention" data-testid="sync-file-failures">
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
      <button type="button"
        aria-expanded={!collapsed}
        aria-controls="sync-failure-panel-content"
        data-testid="button-toggle-sync-failures"
        onClick={() => setCollapsed(value => !value)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown className={`size-4 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} aria-hidden="true" />
        <span className="text-sm font-medium">{data.total ? `${data.total} file${data.total === 1 ? "" : "s"} needing attention` : "File attention"}</span>
        {data.total > 0 && <span className="text-xs font-normal text-muted-foreground">
          Showing {data.failures.length}: {needsAction.length} with issues{skipped.length > 0 && ` · ${skipped.length} not attempted`}
        </span>}
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="button-retry-all-sync-files"
          disabled={!data.canRetryAll || retryAll.isPending || retry.isPending || dismiss.isPending || clearAll.isPending}
          title="Queue retries for all eligible failures across every page, then clear the current notices."
          onClick={() => { retry.reset(); dismiss.reset(); clearAll.reset(); setBulkMessage(""); retryAll.mutate(); }}
          className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-xs font-medium disabled:opacity-50">
          <RefreshCw className={`size-3 ${retryAll.isPending ? "animate-spin" : ""}`} aria-hidden="true" />
          {retryAll.isPending ? "Queuing retries…" : "Retry all failed"}
          {data.retryableCount > 0 && ` (${data.retryableCount})`}
        </button>
        <button type="button" data-testid="button-clear-all-sync-failures"
          disabled={!data.total || clearAll.isPending || retryAll.isPending || retry.isPending || dismiss.isPending}
          title="Dismiss all unresolved file notices across every page."
          onClick={() => { retry.reset(); dismiss.reset(); retryAll.reset(); setBulkMessage(""); clearAll.mutate(); }}
          className="rounded-md border bg-background px-3 py-2 text-xs font-medium disabled:opacity-50">
          {clearAll.isPending ? "Clearing…" : "Clear all"}
        </button>
      </div>
    </div>
    {bulkMessage && <p role="status" className="border-t px-4 py-2 text-xs text-muted-foreground">{bulkMessage}</p>}
    {!collapsed && <div id="sync-failure-panel-content" className="space-y-2 border-t bg-card p-3" data-testid="sync-failure-panel-content">
    {needsAction.map(file => <FailureItem key={file.id} file={file} retry={retryFile} dismiss={dismissFile}
      retryPending={retryAll.isPending || (retry.isPending && retry.variables === file.id)} dismissPending={dismiss.isPending} queued={queued} />)}
    {skipped.length > 0 && <details className="rounded-lg border border-muted-foreground/25 bg-muted/20 p-3"
      data-testid="sync-not-attempted-group">
      <summary className="cursor-pointer text-sm font-medium">
        {skipped.length} file{skipped.length === 1 ? "" : "s"} not attempted in the latest run
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        These files were not attempted because the run stopped or a parent folder was blocked. Expand a file to review its recorded issue history.
      </p>
      <div className="mt-2 space-y-2">
        {skipped.map(file => <FailureItem key={file.id} file={file} compact retry={retryFile} dismiss={dismissFile}
          retryPending={retryAll.isPending || (retry.isPending && retry.variables === file.id)} dismissPending={dismiss.isPending} queued={queued} />)}
      </div>
    </details>}
    {error && <p className="text-sm text-destructive" role="alert">{error instanceof Error ? error.message : "The action failed. Try again."}</p>}
    {(after !== undefined || data.nextAfter !== null) && <div className="flex justify-end gap-3 text-xs">
      <button disabled={!previous.length || query.isFetching} onClick={() => {
        setAfter(previous.at(-1)); setPrevious(previous.slice(0, -1));
      }}>Previous</button>
      <button disabled={data.nextAfter === null || query.isFetching} onClick={() => {
        setPrevious([...previous, after]); setAfter(data.nextAfter ?? undefined);
      }}>Next</button>
    </div>}
    </div>}
  </section>;
}
