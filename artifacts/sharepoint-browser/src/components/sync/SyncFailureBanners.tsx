import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, FolderOpen, RefreshCw, X } from "lucide-react";
import { dismissSyncFileFailure, getSyncFailures, getGetSyncFailuresQueryKey, retrySyncFile } from "@workspace/api-client-react";

export function SyncFailureBanners({ active }: { active: boolean }) {
  const client = useQueryClient();
  const [after, setAfter] = useState<number | undefined>();
  const [previous, setPrevious] = useState<Array<number | undefined>>([]);
  const [queued, setQueued] = useState<{ id: number; text: string }>();
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
  if (!active) return null;
  if (query.isError) return <div className="rounded border p-3 text-sm text-destructive" role="alert">
    File failure notices could not be loaded.
    <button className="ml-2 underline" onClick={() => void query.refetch()}>Retry loading</button>
  </div>;
  const data = query.data;
  if (!data || (!data.total && !retry.error && !dismiss.error)) return null;
  const error = retry.error ?? dismiss.error;
  return <section className="space-y-2" aria-label="Files needing attention" data-testid="sync-file-failures">
    <h3 className="text-sm font-medium">{data.total} file{data.total === 1 ? "" : "s"} needing attention</h3>
    {data.failures.map(file => <div key={file.id} role="alert"
      className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3" data-testid={`sync-failure-${file.id}`}>
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="break-all text-sm font-medium">{file.name}</div>
        <div className="break-all text-xs text-muted-foreground">{file.path}</div>
        <p className="mt-1 text-sm text-destructive">{file.reason}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
            <ExternalLink className="size-3" aria-hidden="true" />Open file in Shufflrr
          </a>
          <a href={file.parentFolderUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
            <FolderOpen className="size-3" aria-hidden="true" />Open parent folder in Shufflrr
          </a>
          <button type="button" disabled={!file.canRetry || retry.isPending}
            title={file.retryRequestedAt ? "Retry queued; provider cooldowns are respected."
              : !file.canRetry ? "Wait for the active run to finish, or restore this file to the saved sync scope." : "Retry only this file; no mirror deletions."}
            onClick={() => { dismiss.reset(); retry.mutate(file.id); }}
            className="inline-flex items-center gap-1 font-medium disabled:opacity-50">
            <RefreshCw className={`size-3 ${retry.isPending && retry.variables === file.id ? "animate-spin" : ""}`} aria-hidden="true" />
            {file.retryRequestedAt ? "Retry queued" : "Try again"}
          </button>
          <span className="text-muted-foreground">Last failure {new Date(file.lastFailedAt).toLocaleString()}</span>
        </div>
        {queued?.id === file.id && <p className="mt-2 text-xs" role="status">{queued.text}</p>}
      </div>
      <button type="button" className="shrink-0 rounded p-1 hover:bg-destructive/10"
        aria-label={`Dismiss failure for ${file.name}`} disabled={dismiss.isPending}
        onClick={() => { retry.reset(); dismiss.mutate(file.id); }}>
        <X className="size-4" />
      </button>
    </div>)}
    {error && <p className="text-sm text-destructive" role="alert">{error instanceof Error ? error.message : "The action failed. Try again."}</p>}
    {(after !== undefined || data.nextAfter !== null) && <div className="flex justify-end gap-3 text-xs">
      <button disabled={!previous.length || query.isFetching} onClick={() => {
        setAfter(previous.at(-1)); setPrevious(previous.slice(0, -1));
      }}>Previous</button>
      <button disabled={data.nextAfter === null || query.isFetching} onClick={() => {
        setPrevious([...previous, after]); setAfter(data.nextAfter ?? undefined);
      }}>Next</button>
    </div>}
  </section>;
}
