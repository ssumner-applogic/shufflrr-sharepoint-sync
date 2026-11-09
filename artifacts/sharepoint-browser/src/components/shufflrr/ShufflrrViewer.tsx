import { useState } from "react";
import { useListShufflrrItems, getListShufflrrItemsQueryKey } from "@workspace/api-client-react";
import { ArrowUp, ChevronRight, Download, ExternalLink, FileText, Folder, Loader2, RotateCw } from "lucide-react";
import { SHUFFLRR_STALE_MS, downloadHref, errorMessage, fmtDate, fmtSize, sortItems } from "./format";

type Crumb = { id?: number; name: string };

export function ShufflrrViewer({ active, onAccessTest }: { active: boolean; onAccessTest: () => void }) {
  const [path, setPath] = useState<Crumb[]>([{ name: "Roots" }]);
  const folderId = path[path.length - 1].id;
  const params = folderId ? { folderId } : undefined;
  const q = useListShufflrrItems(params, {
    query: { queryKey: getListShufflrrItemsQueryKey(params), enabled: active, staleTime: SHUFFLRR_STALE_MS, refetchOnMount: true },
  });
  const items = q.data ? sortItems(q.data.items) : [];

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Shufflrr Viewer</h2>
        </div>
        {q.data?.portalUrl && (
          <a href={q.data.portalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm hover:bg-secondary" data-testid="link-shufflrr-portal">
            <ExternalLink className="size-4" /> Shufflrr portal
          </a>
        )}
      </div>
      <section className="rounded-lg border bg-card" data-testid="shufflrr-browser">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <button onClick={() => setPath(path.slice(0, -1))} disabled={path.length < 2} className="grid size-7 place-items-center rounded border text-muted-foreground hover:bg-secondary disabled:opacity-40" aria-label="Up one folder" data-testid="button-shufflrr-up">
            <ArrowUp className="size-4" />
          </button>
          <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm" aria-label="Breadcrumbs" data-testid="shufflrr-breadcrumbs">
            {path.map((c, i) => (
              <span key={i} className="flex items-center gap-0.5">
                {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
                {i === path.length - 1 ? <span className="px-1 font-medium" aria-current="page">{c.name}</span> : (
                  <button onClick={() => setPath(path.slice(0, i + 1))} className="rounded px-1 text-primary hover:underline" data-testid={`shufflrr-crumb-${i}`}>{c.name}</button>
                )}
              </span>
            ))}
          </nav>
          {q.isFetching && !q.isLoading && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" aria-label="Refreshing" />}
        </div>

        {q.isLoading || (!q.data && !q.isError) ? (
          <div className="divide-y" aria-busy="true">{Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3"><div className="size-4 animate-pulse rounded bg-muted" /><div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${28 + ((i * 19) % 40)}%` }} /></div>
          ))}</div>
        ) : q.isError ? (
          <div className="px-4 py-8 text-sm" role="alert" data-testid="error-shufflrr-list">
            <div className="font-medium text-destructive">Could not read this Shufflrr folder</div>
            <div className="mt-1 break-words text-muted-foreground">{errorMessage(q.error)}</div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={onAccessTest} className="rounded border px-3 py-1.5 hover:bg-secondary" data-testid="button-shufflrr-go-access-test">Go to Access Test</button>
              <button onClick={() => q.refetch()} className="inline-flex items-center gap-1.5 rounded border px-3 py-1.5 hover:bg-secondary" data-testid="button-shufflrr-retry"><RotateCw className="size-3.5" /> Retry</button>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="empty-shufflrr-list">
            {folderId ? "This folder is empty." : "No accessible Shufflrr roots for this account."}
          </div>
        ) : (
          <ul className="divide-y">
            {items.map((it) => {
              const inner = (<>
                {it.isFolder ? <Folder className="size-4 shrink-0 fill-primary/15 text-primary" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{it.name}</span>
                <span className="hidden w-20 text-right font-mono text-xs text-muted-foreground sm:block">{it.isFolder ? "" : fmtSize(it.size)}</span>
                <span className="hidden w-40 text-right font-mono text-xs text-muted-foreground md:block">{fmtDate(it.modifiedAt)}</span>
                {it.isFolder ? <ChevronRight className="size-4 text-muted-foreground" /> : <Download className="size-3.5 text-muted-foreground" />}
              </>);
              const cls = "group flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-secondary/60";
              return (
                <li key={it.id}>
                  {it.isFolder
                    ? <button className={cls} onClick={() => setPath([...path, { id: it.id, name: it.name }])} data-testid={`shufflrr-folder-${it.id}`}>{inner}</button>
                    : <a className={cls} href={downloadHref(it.id)} download={it.name} title={`Download ${it.name}`} data-testid={`shufflrr-file-${it.id}`}>{inner}</a>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
