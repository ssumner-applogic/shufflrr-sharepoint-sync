import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListShufflrrItems, useTestShufflrrAccess, getListShufflrrItemsQueryKey, type DiagnosticStep } from "@workspace/api-client-react";
import { Check, Loader2, Minus, RotateCw, X } from "lucide-react";
import { SHUFFLRR_STALE_MS, errorMessage, fmtDate } from "./format";

function StepIcon({ status }: { status: DiagnosticStep["status"] }) {
  if (status === "passed") return <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><Check className="size-3" strokeWidth={3} /></span>;
  if (status === "failed") return <span className="grid size-5 shrink-0 place-items-center rounded-full bg-destructive text-destructive-foreground"><X className="size-3" strokeWidth={3} /></span>;
  return <span className="grid size-5 shrink-0 place-items-center rounded-full border border-input text-muted-foreground"><Minus className="size-3" /></span>;
}

export function ShufflrrAccessCheck({ active }: { active: boolean }) {
  const qc = useQueryClient();
  const roots = useListShufflrrItems(undefined, {
    query: { queryKey: getListShufflrrItemsQueryKey(), enabled: active, staleTime: SHUFFLRR_STALE_MS, refetchOnMount: true },
  });
  const test = useTestShufflrrAccess({
    mutation: {
      onSuccess: (_r, vars) => {
        void qc.invalidateQueries({ queryKey: getListShufflrrItemsQueryKey() , exact: true });
        void qc.invalidateQueries({ queryKey: getListShufflrrItemsQueryKey({ folderId: vars.data.rootFolderId }), exact: true });
      },
    },
  });
  const [rootId, setRootId] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const folders = (roots.data?.items ?? []).filter((i) => i.isFolder);
  const selected = folders.find((f) => f.id === rootId);
  const report = test.data;

  const run = () => {
    if (!selected || !confirmed) return;
    test.mutate({ data: { rootFolderId: selected.id, confirmTemporaryChanges: true } });
  };

  return (
    <section className="mt-6 rounded-lg border bg-card p-5 sm:p-6" data-testid="shufflrr-access">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Shufflrr access check</h3>
          <p className="mt-1 text-sm text-muted-foreground">Runs only against the selected root folder, not the whole portal.</p>
        </div>
        <button onClick={run} disabled={!selected || !confirmed || test.isPending} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50" data-testid="button-shufflrr-test">
          {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
          {test.isPending ? "Testing" : report ? "Test again" : "Test folder"}
        </button>
      </div>

      <div className="mt-5 space-y-4 text-sm">
        {roots.isLoading || (!roots.data && !roots.isError) ? (
          <div className="h-9 w-full max-w-sm animate-pulse rounded bg-muted" />
        ) : roots.isError ? (
          <div role="alert" data-testid="error-shufflrr-roots">
            <span className="text-destructive">Could not load Shufflrr roots: {errorMessage(roots.error)}</span>
            <button onClick={() => roots.refetch()} className="ml-2 text-primary underline" data-testid="button-shufflrr-retry-roots">Retry</button>
          </div>
        ) : folders.length === 0 ? (
          <div className="text-muted-foreground" data-testid="empty-shufflrr-roots">No accessible root folders to test.</div>
        ) : (
          <>
            <label className="block">
              <span className="mb-1.5 block font-medium">Target root folder</span>
              <select value={rootId ?? ""} onChange={(e) => { setRootId(e.target.value ? Number(e.target.value) : null); setConfirmed(false); test.reset(); }} disabled={test.isPending} className="w-full max-w-sm rounded-md border bg-background px-3 py-2" data-testid="select-shufflrr-root">
                <option value="">Select a folder</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
            {selected && (
              <div className="text-muted-foreground" data-testid="text-shufflrr-permissions">
                Reported permissions: <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-foreground">{selected.permissions || "none reported"}</code>
                <span className="mt-1 block text-xs">Reported by Shufflrr; this does not prove write access. Only the test below verifies it.</span>
              </div>
            )}
            <label className="flex items-start gap-2.5 rounded-md border bg-secondary/40 p-3">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={test.isPending} className="mt-0.5 size-4 accent-[hsl(var(--primary))]" data-testid="checkbox-shufflrr-confirm" />
              <span>I understand this test will create, rename and then delete a temporary folder and file inside the selected root folder. Existing content is not modified.</span>
            </label>
          </>
        )}

        {test.isPending && <div className="text-muted-foreground" role="status" data-testid="status-shufflrr-pending">Running checks in {selected?.name}...</div>}
        {test.isError && <div className="text-destructive" role="alert" data-testid="error-shufflrr-test">{errorMessage(test.error)}</div>}

        {report && !test.isPending && (
          <div className="rise space-y-4" data-testid="shufflrr-report">
            <div className={`rounded-md border px-4 py-3 ${report.ok ? "border-primary/30 bg-accent text-accent-foreground" : "border-destructive/30 bg-destructive/8 text-destructive"}`}>
              <div className="font-medium" data-testid="status-shufflrr-access">{report.ok ? "Folder access confirmed" : "Folder access check failed"}</div>
              <div className="mt-0.5 text-xs opacity-80">Scope: {report.scope} · {fmtDate(report.checkedAt)}</div>
            </div>
            {!report.cleanupOk && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive" role="alert" data-testid="status-shufflrr-cleanup">
                Cleanup failed. Temporary test items may remain in the selected folder and should be removed manually.
              </div>
            )}
            <ol className="space-y-3">
              {report.steps.map((s, i) => (
                <li key={i} className="flex gap-3" data-testid={`shufflrr-step-${i}`}>
                  <StepIcon status={s.status} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{s.name} <span className="ml-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{s.status}</span></div>
                    {s.message && <div className="break-words text-muted-foreground">{s.message}</div>}
                    {(s.code || s.requestId) && <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{s.code && <>code {s.code}</>}{s.code && s.requestId && " · "}{s.requestId && <>request-id {s.requestId}</>}</div>}
                  </div>
                </li>
              ))}
            </ol>
            {report.advice.length > 0 && <ul className="list-disc space-y-1 pl-5">{report.advice.map((a, i) => <li key={i}>{a}</li>)}</ul>}
          </div>
        )}
      </div>
    </section>
  );
}
