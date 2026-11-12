import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  getSyncIgnoredFiles, reenableSyncFiles, getGetSyncIgnoredFilesQueryKey,
  getGetSyncConfigQueryKey, getGetSyncDashboardQueryKey, getGetSyncFailuresQueryKey,
} from "@workspace/api-client-react";
import { SharePointFailureLinks } from "./SharePointFailureLinks";

export function SyncIgnoredFiles({ active, open, setOpen, running }: {
  active: boolean; open: boolean; setOpen: (open: boolean) => void; running: boolean;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState("");
  const query = useQuery({ queryKey: getGetSyncIgnoredFilesQueryKey(),
    queryFn: ({ signal }) => getSyncIgnoredFiles({ signal }), enabled: active, refetchInterval: active ? 5000 : false });
  const rows = query.data ?? [];
  const reenable = useMutation({
    mutationFn: (ruleIds: number[]) => reenableSyncFiles({ ruleIds }),
    onSuccess: async () => {
      setSelected(new Set());
      setMessage("Ignore rules removed. No files were changed. Any occupied-path conflicts still require overwrite approval.");
      await Promise.all([getGetSyncIgnoredFilesQueryKey(), getGetSyncFailuresQueryKey(),
        getGetSyncConfigQueryKey(), getGetSyncDashboardQueryKey()].map(queryKey => client.invalidateQueries({ queryKey })));
    },
  });
  return <section id="sync-ignored-files" className="rounded-md border bg-card" data-testid="sync-ignored-files">
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="ignored-files-content"
        className="inline-flex items-center gap-2 text-sm font-medium" data-testid="button-toggle-ignored-files">
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}Ignored files ({rows.length})
      </button>
      {open && <button type="button" disabled={!selected.size || running || reenable.isPending}
        onClick={() => reenable.mutate([...selected])}
        title={running ? "Wait for the active run to finish." : "Remove selected ignore rules; do not overwrite files."}
        className="rounded border px-3 py-2 text-xs disabled:opacity-50">Re-enable selected ({selected.size})</button>}
    </div>
    {open && <div id="ignored-files-content" className="space-y-3 border-t p-3">
      <p className="text-xs text-muted-foreground">Persistent exclusions apply only to their original source/target pairing. Re-enabling restores normal conflict protection, not overwrite permission.</p>
      {query.isLoading && <p className="text-sm">Loading ignore rules…</p>}
      {query.isError && <p role="alert" className="text-sm text-destructive">Could not load ignore rules. <button className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
      {!query.isLoading && !query.isError && !rows.length && <p className="text-sm text-muted-foreground">No files are ignored.</p>}
      {rows.length > 0 && <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={selected.size > 0 && rows.slice(0, 100).every(row => selected.has(row.id))}
          onChange={event => setSelected(new Set(event.target.checked ? rows.slice(0, 100).map(row => row.id) : []))} />
        Select up to 100 rules
      </label>}
      <div className="max-h-96 space-y-2 overflow-y-auto">
        {rows.map(row => <div key={row.id} className="flex items-start gap-3 rounded border p-3" data-testid={`ignored-file-${row.id}`}>
          <input type="checkbox" aria-label={`Select ignore rule for ${row.name}`} checked={selected.has(row.id)}
            disabled={!selected.has(row.id) && selected.size >= 100}
            onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; })} />
          <div className="min-w-0 flex-1 text-xs">
            <p className="break-all text-sm font-medium">{row.name}</p>
            <p className="break-all text-muted-foreground">{row.path} → {row.destinationFolderName}</p>
            <p className="mt-1 text-muted-foreground">Ignored {new Date(row.createdAt).toLocaleString()} · {row.active ? "Active in current mapping" : "Outside current mapping"}</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <a className="underline" href={row.fileUrl} target="_blank" rel="noopener noreferrer">Open file in Shufflrr</a>
              <a className="underline" href={row.parentFolderUrl} target="_blank" rel="noopener noreferrer">Open parent folder in Shufflrr</a>
              <SharePointFailureLinks failureId={row.failureId} />
            </div>
          </div>
          <button type="button" disabled={running || reenable.isPending} onClick={() => reenable.mutate([row.id])}
            className="rounded border px-2 py-1 text-xs disabled:opacity-50" data-testid={`button-reenable-file-${row.id}`}>Re-enable sync</button>
        </div>)}
      </div>
      {message && <p role="status" className="text-xs">{message}</p>}
      {reenable.error && <p role="alert" className="text-sm text-destructive">{reenable.error instanceof Error ? reenable.error.message : "Could not remove the rules."}</p>}
    </div>}
  </section>;
}
