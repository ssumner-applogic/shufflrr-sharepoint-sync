import { useEffect, useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetConnectionStatus,
  useTestConnection,
  useListItems,
  getGetConnectionStatusQueryKey,
  getListItemsQueryKey,
  type AccessReport,
  type DiagnosticStep,
} from "@workspace/api-client-react";
import {
  ArrowUp, Check, ChevronRight, ExternalLink, FileText, Files, Folder, Loader2, Minus, RotateCw, ShieldCheck, X,
} from "lucide-react";

type Crumb = { id?: string; name: string };
type Panel = "access" | "viewer";
const appName = "Shufflrr-SharePoint Sync Agent";

function handleTabKeys(event: KeyboardEvent<HTMLElement>) {
  const key = event.key;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;

  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const currentTab = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
  if (!currentTab) return;
  const currentIndex = tabs.indexOf(currentTab);
  if (currentIndex < 0) return;

  const nextIndex = key === "Home" ? 0
    : key === "End" ? tabs.length - 1
      : key === "ArrowDown" ? (currentIndex + 1) % tabs.length
        : (currentIndex - 1 + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtDate(s: string) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function StepIcon({ status }: { status: DiagnosticStep["status"] }) {
  if (status === "passed") return <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground"><Check className="size-3" strokeWidth={3} /></span>;
  if (status === "failed") return <span className="grid size-5 place-items-center rounded-full bg-destructive text-destructive-foreground"><X className="size-3" strokeWidth={3} /></span>;
  return <span className="grid size-5 place-items-center rounded-full border border-input text-muted-foreground"><Minus className="size-3" /></span>;
}

function Report({ report }: { report: AccessReport }) {
  return (
    <div className="rise mt-5 space-y-5" data-testid="report">
      <div className={`flex items-center justify-between rounded-md border px-4 py-3 text-sm ${report.ok ? "border-primary/30 bg-accent text-accent-foreground" : "border-destructive/30 bg-destructive/8 text-destructive"}`}>
        <span className="font-medium" data-testid="status-access">{report.ok ? "Access confirmed" : "Access check failed"}</span>
      </div>
      <ol className="space-y-3">
        {report.steps.map((s, i) => (
          <li key={i} className="flex gap-3" data-testid={`step-${i}`}>
            <StepIcon status={s.status} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">{s.name} <span className="ml-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{s.status}</span></div>
              {(s.status === "failed" || s.name === "Verify write access") && <div className="break-words text-muted-foreground">{s.message}</div>}
              {(s.code || s.requestId) && (
                <div className="mt-1 font-mono text-[11px] text-muted-foreground break-all">
                  {s.code && <>code {s.code}</>}{s.code && s.requestId && " · "}{s.requestId && <>request-id {s.requestId}</>}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {!report.ok && report.advice.length > 0 && (
        <div>
          <ul className="list-disc space-y-1 pl-5 text-sm">{report.advice.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function Browser({ libraryName, onAccessTest }: { libraryName: string; onAccessTest: () => void }) {
  const [path, setPath] = useState<Crumb[]>([{ name: libraryName }]);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const folderId = path[path.length - 1].id;
  const cursor = cursors[cursors.length - 1];
  const params = { ...(folderId ? { folderId } : {}), ...(cursor ? { cursor } : {}) };
  const q = useListItems(params, { query: { queryKey: getListItemsQueryKey(params) } });

  const go = (p: Crumb[]) => { setPath(p); setCursors([undefined]); };
  const err = q.error?.data as { error?: string; advice?: string[] } | null | undefined;

  return (
    <section className="rise rounded-lg border bg-card" data-testid="browser">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <button
          onClick={() => go(path.slice(0, -1))}
          disabled={path.length < 2}
          className="grid size-7 place-items-center rounded border text-muted-foreground hover:bg-secondary disabled:opacity-40"
          aria-label="Up one folder" data-testid="button-up"
        ><ArrowUp className="size-4" /></button>
        <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm" data-testid="breadcrumbs">
          {path.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
              {i === path.length - 1 ? <span className="px-1 font-medium">{c.name}</span> : (
                <button onClick={() => go(path.slice(0, i + 1))} className="rounded px-1 text-primary hover:underline" data-testid={`crumb-${i}`}>{c.name}</button>
              )}
            </span>
          ))}
        </nav>
        {q.isFetching && !q.isLoading && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" />}
      </div>

      {q.isLoading ? (
        <div className="divide-y">{Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3"><div className="size-4 rounded bg-muted animate-pulse" /><div className="h-3 rounded bg-muted animate-pulse" style={{ width: `${30 + ((i * 17) % 40)}%` }} /></div>
        ))}</div>
      ) : q.isError ? (
        <div className="px-4 py-8 text-sm" data-testid="error-list" role="alert">
          <div className="font-medium text-destructive">Could not read this folder</div>
          <div className="mt-1 text-muted-foreground">{err?.error ?? q.error?.message}</div>
          {err?.advice && err.advice.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5">{err.advice.map((a, i) => <li key={i}>{a}</li>)}</ul>}
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={onAccessTest} className="rounded border px-3 py-1.5 hover:bg-secondary" data-testid="button-go-access-test">Go to Access Test</button>
            <button onClick={() => q.refetch()} className="inline-flex items-center gap-1.5 rounded border px-3 py-1.5 hover:bg-secondary" data-testid="button-retry-list"><RotateCw className="size-3.5" /> Retry</button>
          </div>
        </div>
      ) : q.data && q.data.items.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="empty-list">This folder is empty.</div>
      ) : (
        <ul className="divide-y">
          {q.data?.items.map((it) => {
            const inner = (<>
              {it.isFolder ? <Folder className="size-4 shrink-0 fill-primary/15 text-primary" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{it.name}</span>
              <span className="hidden w-20 text-right font-mono text-xs text-muted-foreground sm:block">{it.isFolder ? "" : fmtSize(it.size)}</span>
              <span className="hidden w-40 text-right font-mono text-xs text-muted-foreground md:block">{fmtDate(it.modifiedAt)}</span>
              {it.isFolder ? <ChevronRight className="size-4 text-muted-foreground" /> : <ExternalLink className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />}
            </>);
            const cls = "group flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-secondary/60";
            return (
              <li key={it.id}>
                {it.isFolder
                  ? <button className={cls} onClick={() => go([...path, { id: it.id, name: it.name }])} data-testid={`folder-${it.id}`}>{inner}</button>
                  : <a className={cls} href={it.webUrl} target="_blank" rel="noopener noreferrer" data-testid={`file-${it.id}`}>{inner}</a>}
              </li>
            );
          })}
        </ul>
      )}

      {(cursors.length > 1 || q.data?.nextCursor) && !q.isError && (
        <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm">
          <button disabled={cursors.length < 2} onClick={() => setCursors(cursors.slice(0, -1))} className="rounded border px-3 py-1 hover:bg-secondary disabled:opacity-40" data-testid="button-prev">Previous</button>
          <span className="font-mono text-xs text-muted-foreground">page {cursors.length}</span>
          <button disabled={!q.data?.nextCursor} onClick={() => setCursors([...cursors, q.data?.nextCursor])} className="rounded border px-3 py-1 hover:bg-secondary disabled:opacity-40" data-testid="button-next">Next</button>
        </div>
      )}
    </section>
  );
}

export default function Home() {
  const qc = useQueryClient();
  const status = useGetConnectionStatus({ query: { queryKey: getGetConnectionStatusQueryKey() } });
  const test = useTestConnection();
  const [session, setSession] = useState(0);
  const [panel, setPanel] = useState<Panel>("viewer");
  const report = test.data;
  const readOk = !test.isPending && !!report && report.steps.slice(0, 4).every((step) => step.status === "passed");
  const writeFailed = readOk && report.steps.some((step) => step.name === "Verify write access" && step.status === "failed");

  const run = () => {
    test.mutate(undefined, {
      onSuccess: (r) => {
        qc.removeQueries({ queryKey: ["/api/sharepoint/items"] });
        if (r.steps.slice(0, 4).every((step) => step.status === "passed")) setSession((n) => n + 1);
      },
    });
  };

  const s = status.data;

  useEffect(() => {
    if (panel === "viewer" && status.isSuccess && s?.configured && !test.isPending) {
      run();
    }
  }, [panel, status.isSuccess, s?.configured]);

  const viewerHasError = status.isError || (status.isSuccess && !s?.configured) || test.isError || (!!report && report.steps.slice(0, 4).some((step) => step.status === "failed"));
  const viewerIsConnecting = status.isLoading || (status.isSuccess && s?.configured && (test.isPending || (!report && !test.isError)));

  return (
    <div className="min-h-[100dvh]">
      <aside className="fixed inset-y-0 left-0 z-10 flex w-[4.25rem] flex-col items-center border-r bg-card py-4">
        <nav className="flex flex-col gap-2" role="tablist" aria-label="Application panels" aria-orientation="vertical" onKeyDown={handleTabKeys}>
          <button
            type="button"
            role="tab"
            id="tab-viewer"
            aria-label="SharePoint Document Viewer"
            aria-controls="panel-viewer"
            aria-selected={panel === "viewer"}
            tabIndex={panel === "viewer" ? 0 : -1}
            title="SharePoint Document Viewer"
            onClick={() => setPanel("viewer")}
            className={`grid size-10 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${panel === "viewer" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
            data-testid="tab-viewer"
          >
            <Files className="size-5" />
          </button>
          <button
            type="button"
            role="tab"
            id="tab-access"
            aria-label="Access Test"
            aria-controls="panel-access"
            aria-selected={panel === "access"}
            tabIndex={panel === "access" ? 0 : -1}
            title="Access Test"
            onClick={() => setPanel("access")}
            className={`grid size-10 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${panel === "access" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
            data-testid="tab-access"
          >
            <ShieldCheck className="size-5" />
          </button>
        </nav>
      </aside>

      <div className="min-h-[100dvh] pl-[4.25rem]">
        <header className="sticky top-0 z-[1] flex min-h-16 items-center border-b bg-background/95 px-5 backdrop-blur sm:px-8">
          <h1 className="text-base font-semibold tracking-tight sm:text-lg">{appName}</h1>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <section
            id="panel-access"
            role="tabpanel"
            aria-labelledby="tab-access"
            hidden={panel !== "access"}
            className="rise"
            data-testid="panel-access"
          >
            <div className="mb-5 flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">Access Test</h2>
              {s && (
                <button
                  onClick={run}
                  disabled={!s.configured || test.isPending}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  data-testid="button-test"
                >
                  {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                  {test.isPending ? "Testing" : report ? "Test again" : "Test"}
                </button>
              )}
            </div>

            <section className="rounded-lg border bg-card p-5 sm:p-6">
              {status.isLoading ? (
                <div className="h-5 w-48 animate-pulse rounded bg-muted" />
              ) : status.isError ? (
                <div className="text-sm">
                  <span className="text-destructive">Configuration unavailable.</span>
                  <button onClick={() => status.refetch()} className="ml-2 text-primary underline" data-testid="button-retry-status">Retry</button>
                </div>
              ) : s && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-medium" data-testid="status-configured">
                      {s.configured ? "Credentials ready" : "Credentials missing"}
                    </div>
                  </div>
                  {!s.configured && s.missing.length > 0 && (
                    <div className="mt-3 text-sm" data-testid="text-missing">
                      {s.missing.map((m) => <code key={m} className="mr-1.5 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{m}</code>)}
                    </div>
                  )}
                  {test.isError && <div className="mt-4 text-sm text-destructive" data-testid="error-test">{test.error?.message}</div>}
                  {report && !test.isPending && <Report report={report} />}
                </>
              )}
            </section>
          </section>

          <section
            id="panel-viewer"
            role="tabpanel"
            aria-labelledby="tab-viewer"
            hidden={panel !== "viewer"}
            className="rise"
            data-testid="panel-viewer"
          >
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">SharePoint Document Viewer</h2>
                {s && <p className="mt-1 text-sm text-muted-foreground">{s.siteName} / {s.libraryName}</p>}
              </div>
              {s?.libraryUrl && (
                <a
                  href={s.libraryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm hover:bg-secondary"
                  data-testid="link-sharepoint-root"
                >
                  <ExternalLink className="size-4" />
                  Shared document root
                </a>
              )}
            </div>
            {readOk && s ? (
              <>
                {writeFailed && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="alert">
                    <span className="text-destructive">Write access check failed.</span>
                    <button onClick={() => setPanel("access")} className="rounded border bg-card px-3 py-1.5 hover:bg-secondary" data-testid="button-open-access-test">Go to Access Test</button>
                  </div>
                )}
                <Browser key={session} libraryName={s.libraryName || "Shared Documents"} onAccessTest={() => setPanel("access")} />
              </>
            ) : (
              <div className="rounded-lg border bg-card px-5 py-10 text-center text-sm" role={viewerHasError ? "alert" : "status"}>
                <p className={viewerHasError ? "text-destructive" : "text-muted-foreground"}>
                  {viewerIsConnecting
                    ? "Connecting to SharePoint…"
                    : status.isError
                      ? "SharePoint connection unavailable."
                      : status.isSuccess && !s?.configured
                        ? "SharePoint credentials missing."
                        : test.isError || report?.ok === false
                          ? "Could not connect to the SharePoint folder."
                          : "Connecting to SharePoint…"}
                </p>
                {viewerHasError && (
                  <button
                    onClick={() => setPanel("access")}
                    className="mt-4 rounded border px-3 py-1.5 hover:bg-secondary"
                    data-testid="button-open-access-test"
                  >
                    Go to Access Test
                  </button>
                )}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
