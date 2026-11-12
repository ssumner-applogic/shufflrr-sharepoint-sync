import { useMemo } from "react";
import { AlertTriangle, Info, Loader2 } from "lucide-react";
import {
  getGetSyncDashboardQueryKey,
  useGetSyncDashboard,
  type SyncConfig,
  type SyncInventoryTotals,
} from "@workspace/api-client-react";

export function syncDashboardScopeKey(config: SyncConfig | undefined) {
  return [
    ...getGetSyncDashboardQueryKey(),
    {
      destination: config?.destinationFolderId ?? null,
      sources: (config?.sourceFolders ?? []).map(folder => folder.id).sort((a, b) => a - b),
      excluded: (config?.excludedFolders ?? []).map(folder => `${folder.rootId}:${folder.id}`).sort(),
    },
  ] as const;
}

const countFormat = new Intl.NumberFormat();
function mb(bytes: number) {
  return `${(bytes / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`;
}

function Metric({ label, value, detail, tone, testId }: {
  label: string; value: string; detail?: string; tone?: "ok" | "warn" | "bad"; testId: string;
}) {
  const toneClass = tone === "ok" ? "text-primary" : tone === "bad" ? "text-destructive" : tone === "warn" ? "text-amber-700" : "text-foreground";
  return (
    <div className="min-w-0 bg-card px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-xl font-semibold tabular-nums ${toneClass}`} data-testid={testId}>{value}</div>
      {detail && <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function Totals({ inventory, stale }: { inventory: SyncInventoryTotals; stale: boolean }) {
  const partial = inventory.sourceUnknownSizeFiles > 0;
  return (
    <div className={stale ? "opacity-60" : ""}>
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Shufflrr source files" value={countFormat.format(inventory.sourceFiles)} testId="text-dashboard-source-files"
          detail={`${mb(inventory.sourceBytes)}${partial ? " (known sizes only)" : ""}`} />
        <Metric label="Synchronized to SharePoint" value={countFormat.format(inventory.synchronizedFiles)} tone="ok"
          testId="text-dashboard-synced-files" detail={`${mb(inventory.synchronizedBytes)} stored`} />
        <Metric label="Not yet synchronized" value={countFormat.format(inventory.notSynchronizedFiles)}
          tone={inventory.notSynchronizedFiles > 0 ? "warn" : undefined} testId="text-dashboard-not-synced-files"
          detail={`${countFormat.format(inventory.failedFiles)} failed + ${countFormat.format(inventory.pendingFiles)} pending`} />
        <Metric label="Failed (incl. conflicts)" value={countFormat.format(inventory.failedFiles)}
          tone={inventory.failedFiles > 0 ? "bad" : undefined} testId="text-dashboard-failed-files"
          detail={`${countFormat.format(inventory.pendingFiles)} pending`} />
        <Metric label="Ignored" value={countFormat.format(inventory.ignoredFiles ?? 0)} testId="text-dashboard-ignored-files"
          detail={`${mb(inventory.ignoredBytes ?? 0)} excluded`} />
      </div>
      {partial && (
        <p className="mt-2 text-xs text-amber-700" data-testid="text-dashboard-partial-size">
          Source size is partial: {countFormat.format(inventory.sourceUnknownSizeFiles)} file{inventory.sourceUnknownSizeFiles === 1 ? "" : "s"} reported no size and {inventory.sourceUnknownSizeFiles === 1 ? "is" : "are"} counted but not sized.
        </p>
      )}
    </div>
  );
}

export function SyncDashboard({ active, config, reviewIgnored }: { active: boolean; config: SyncConfig | undefined; reviewIgnored: () => void }) {
  const queryKey = useMemo(() => syncDashboardScopeKey(config), [config?.destinationFolderId, config?.sourceFolders, config?.excludedFolders]);
  const dashboard = useGetSyncDashboard({
    query: { queryKey, enabled: active && !!config, refetchInterval: active ? 5000 : false, refetchIntervalInBackground: false },
  });
  const data = dashboard.data;
  const inventory = data?.inventory ?? null;
  const showError = dashboard.isError;

  return (
    <section className="rounded-md border bg-card px-4 py-3" aria-labelledby="sync-dashboard-title" data-testid="sync-dashboard">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="sync-dashboard-title" className="text-sm font-medium">Scope totals</h3>
        <button type="button" onClick={reviewIgnored} className="text-xs underline" data-testid="button-dashboard-review-ignored">
          {config?.ignoredFileCount ?? 0} active ignore rule{config?.ignoredFileCount === 1 ? "" : "s"} · Review
        </button>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-dashboard-scanned-at">
          {data?.running && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
          {inventory ? `Last full source scan ${new Date(inventory.scannedAt).toLocaleString()}` : data?.running ? "Scan in progress" : null}
        </span>
      </div>

      <div className="mt-3">
        {showError && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
            <AlertTriangle className="size-4" aria-hidden="true" />
            {inventory ? "Could not refresh totals. Showing the last loaded values, which may be out of date." : "Could not load scope totals."}
            <button type="button" className="underline" onClick={() => void dashboard.refetch()} data-testid="button-retry-dashboard">Retry</button>
          </div>
        )}
        {!data && dashboard.isLoading && (
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 lg:grid-cols-4" aria-label="Loading scope totals" role="status">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="bg-card px-4 py-3">
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-6 w-16 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        )}
        {data && !data.configured && (
          <p className="text-sm text-muted-foreground" data-testid="text-dashboard-unconfigured">
            No sync scope selected yet. Open folder configuration, choose a SharePoint destination and the Shufflrr folders to include, then save to see totals here.
          </p>
        )}
        {data && data.configured && !inventory && (
          <p className="text-sm text-muted-foreground" data-testid="text-dashboard-awaiting">
            Awaiting the first full-scope scan. Totals appear after the source and destination have been scanned{data.running ? "; a run is in progress." : "."}
          </p>
        )}
        {data && data.configured && inventory && <Totals inventory={inventory} stale={showError} />}
      </div>

      {data?.configured && (
        <p className="mt-3 flex gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Files only, within the selected scope and excluding excluded folders. Ignored files are shown separately, not as failed, pending, or synchronized. Changing ignore rules requires a new full scan for these totals; the active rule count updates immediately. Targeted retries are reflected after the next full scan.
            SharePoint adds a small amount of metadata to Office files, so stored size can be slightly larger than the source.
          </span>
        </p>
      )}
    </section>
  );
}
