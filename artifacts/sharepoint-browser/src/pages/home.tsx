import { useState, type KeyboardEvent } from "react";
import { useClerk, useUser } from "@clerk/react";
import {
  useGetConnectionStatus,
  useTestConnection,
  endShufflrrSession,
  getGetConnectionStatusQueryKey,
  type AccessReport,
  type DiagnosticStep,
} from "@workspace/api-client-react";
import {
  Check, ExternalLink, FileText, Files, Loader2, LogOut, Minus, RefreshCw, RotateCw, ShieldCheck, UserRound, X,
} from "lucide-react";
import { ShufflrrViewer } from "@/components/shufflrr/ShufflrrViewer";
import { SharePointTree } from "@/components/sharepoint/SharePointTree";
import { ShufflrrAccessCheck } from "@/components/shufflrr/ShufflrrAccessCheck";
import { SyncAgent } from "@/components/sync/SyncAgent";

type Panel = "access" | "viewer" | "shufflrr" | "sync";
const appName = "Shufflrr-SharePoint Sync Agent";

function AccountActions() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const [signingOut, setSigningOut] = useState(false);
  const logout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await endShufflrrSession({ signal: AbortSignal.timeout(5000) });
    } catch {
      // Cleanup must never prevent Clerk from revoking the app session.
      console.warn("Shufflrr connection cleanup could not be confirmed. Continuing app sign-out.");
    } finally {
      try { await signOut({ redirectUrl: "/" }); }
      finally { setSigningOut(false); }
    }
  };
  if (!isLoaded || !user) return null;

  const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "Signed in";
  const initials = [user.firstName?.[0], user.lastName?.[0]].filter(Boolean).join("").toUpperCase();

  return (
    <div className="flex min-w-0 items-center gap-2 sm:gap-3">
      {user.imageUrl ? (
        <img
          src={user.imageUrl}
          alt="Profile"
          className="size-8 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-xs font-medium text-accent-foreground"
          aria-hidden="true"
        >
          {initials || <UserRound className="size-4" />}
        </span>
      )}
      <span className="hidden max-w-[min(36vw,18rem)] truncate text-sm text-muted-foreground sm:block">
        {email}
      </span>
      <button
        type="button"
        onClick={() => void logout()}
        disabled={signingOut}
        aria-busy={signingOut}
        aria-label="Log out"
        title="Log out"
        className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {signingOut ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <LogOut className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

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

export default function Home() {
  const status = useGetConnectionStatus({ query: { queryKey: getGetConnectionStatusQueryKey() } });
  const test = useTestConnection();
  const [panel, setPanel] = useState<Panel>("viewer");
  const report = test.data;
  const readOk = !!report && report.steps.slice(0, 4).every((step) => step.status === "passed");
  const writeFailed = readOk && report?.steps.some((step) => step.name === "Verify write access" && step.status === "failed");

  const run = () => {
    test.mutate();
  };

  const s = status.data;

  const viewerHasError = status.isError || (status.isSuccess && !s?.configured);
  const viewerIsConnecting = status.isLoading;

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
            id="tab-shufflrr"
            aria-label="Shufflrr Viewer"
            aria-controls="panel-shufflrr"
            aria-selected={panel === "shufflrr"}
            tabIndex={panel === "shufflrr" ? 0 : -1}
            title="Shufflrr Viewer"
            onClick={() => setPanel("shufflrr")}
            className={`grid size-10 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${panel === "shufflrr" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
            data-testid="tab-shufflrr"
          >
            <FileText className="size-5" />
          </button>
          <button
            type="button"
            role="tab"
            id="tab-sync"
            aria-label="Sync Agent"
            aria-controls="panel-sync"
            aria-selected={panel === "sync"}
            tabIndex={panel === "sync" ? 0 : -1}
            title="Sync Agent"
            onClick={() => setPanel("sync")}
            className={`grid size-10 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${panel === "sync" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
            data-testid="tab-sync"
          >
            <RefreshCw className="size-5" />
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
        <header className="sticky top-0 z-[1] flex min-h-16 items-center justify-between gap-4 border-b bg-background/95 px-5 backdrop-blur sm:px-8">
          <h1 className="text-base font-semibold tracking-tight sm:text-lg">{appName}</h1>
          <AccountActions />
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
            <ShufflrrAccessCheck active={panel === "access"} />
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
            {s?.configured ? (
              <>
                {writeFailed && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="alert">
                    <span className="text-destructive">Write access check failed.</span>
                    <button onClick={() => setPanel("access")} className="rounded border bg-card px-3 py-1.5 hover:bg-secondary" data-testid="button-open-access-test">Go to Access Test</button>
                  </div>
                )}
                <SharePointTree libraryName={s.libraryName || "Shared Documents"} active={panel === "viewer"} onAccessTest={() => setPanel("access")} />
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

          <section
            id="panel-shufflrr"
            role="tabpanel"
            aria-labelledby="tab-shufflrr"
            hidden={panel !== "shufflrr"}
            className="rise"
            data-testid="panel-shufflrr"
          >
            <ShufflrrViewer active={panel === "shufflrr"} onAccessTest={() => setPanel("access")} />
          </section>
          <section
            id="panel-sync"
            role="tabpanel"
            aria-labelledby="tab-sync"
            hidden={panel !== "sync"}
            className="rise"
            data-testid="panel-sync"
          >
            <SyncAgent active={panel === "sync"} />
          </section>
        </main>
      </div>
    </div>
  );
}
