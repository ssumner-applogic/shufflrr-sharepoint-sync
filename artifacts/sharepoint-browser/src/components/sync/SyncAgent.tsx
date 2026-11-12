import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Loader2,
  RefreshCw,
  Save,
  Settings,
  X,
} from "lucide-react";
import {
  dismissSyncOrphan,
  disconnectSync,
  getSyncConfig,
  getGetSyncConfigQueryKey,
  getGetSyncDashboardQueryKey,
  getGetSyncFailuresQueryKey,
  getGetSyncRunsQueryKey,
  getListShufflrrItemsQueryKey,
  listItems,
  listShufflrrItems,
  requestSyncNow,
  saveSyncConfig,
  setSyncEnabled,
  setSyncInterval,
  type LibraryItem,
  type SyncConfig,
  type SyncConfigInput,
  type SyncSourceFolder,
  type SyncFolderExclusion,
} from "@workspace/api-client-react";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { SyncActivityLog } from "./SyncActivityLog";
import { SyncDashboard } from "./SyncDashboard";
import { SyncDisconnectControl } from "./SyncDisconnectControl";
import { SyncIgnoredFiles } from "./SyncIgnoredFiles";
import { SyncFailureBanners } from "./SyncFailureBanners";
import { currentExclusionAncestors, folderSelectionState, toggleFolderSelection } from "./folder-selection";
import { shouldClearBusySyncError } from "./sync-request-state";

function errorText(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  return error ? "The request could not be completed." : null;
}

function useSharePointFolders(folderId: string | undefined, active: boolean, expanded: boolean) {
  return useQuery({
    queryKey: ["sync-sharepoint-folders", folderId ?? null],
    queryFn: async ({ signal }) => {
      const all: LibraryItem[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await listItems({
          ...(folderId ? { folderId } : {}),
          ...(cursor ? { cursor } : {}),
        }, { signal });
        all.push(...page.items.filter(item => item.isFolder));
        cursor = page.nextCursor;
        if (++pages > 100) throw new Error("Too many folders to display.");
      } while (cursor);
      return all;
    },
    enabled: active && expanded,
    staleTime: 30_000,
  });
}

type SharePointBranchProps = {
  folderId?: string;
  level: number;
  active: boolean;
  disabled: boolean;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (folder: { id: string; name: string }) => void;
};

function SharePointFolderBranch({ folderId, level, active, disabled, expanded, toggle, selectedId, onSelect }: SharePointBranchProps) {
  const folders = useSharePointFolders(folderId, active, folderId === undefined || (!!folderId && expanded.has(folderId)));
  const children = folders.data ?? [];

  if (folders.isError) {
    return (
      <div className="py-1 text-sm text-destructive" style={{ paddingLeft: `${level * 18}px` }}>
        Could not load SharePoint folders.
        <button type="button" className="ml-2 underline" onClick={() => void folders.refetch()}>Retry</button>
      </div>
    );
  }
  if (folders.isLoading) {
    return <div className="py-1 text-sm text-muted-foreground" style={{ paddingLeft: `${level * 18}px` }}>…</div>;
  }

  return (
    <div>
      {children.map(folder => {
        const itemOpen = expanded.has(folder.id);
        return (
          <div key={folder.id}>
            <div
              className="flex min-h-9 items-center gap-2 rounded px-1 hover:bg-secondary"
              style={{ paddingLeft: `${level * 18}px` }}
            >
              <button
                type="button"
                disabled={disabled}
                className="grid size-7 shrink-0 place-items-center rounded hover:bg-background"
                aria-label={`${itemOpen ? "Collapse" : "Expand"} ${folder.name}`}
                onClick={() => toggle(folder.id)}
              >
                {itemOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
              <Folder className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <button
                type="button"
                disabled={disabled}
                className={`min-w-0 flex-1 truncate text-left text-sm ${selectedId === folder.id ? "font-medium text-primary" : ""}`}
                onClick={() => onSelect({ id: folder.id, name: folder.name })}
                aria-pressed={selectedId === folder.id}
              >
                {folder.name}
              </button>
            </div>
            {itemOpen && (
              <SharePointFolderBranch
                folderId={folder.id}
                level={level + 1}
                active={active}
                disabled={disabled}
                expanded={expanded}
                toggle={toggle}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
      {!children.length && !folders.isLoading && (
        <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: `${(level + 1) * 18}px` }}>No folders</div>
      )}
    </div>
  );
}

function useShufflrrFolders(folderId: number | undefined, active: boolean, expanded: boolean) {
  const params = folderId ? { folderId } : undefined;
  return useQuery({
    queryKey: getListShufflrrItemsQueryKey(params),
    queryFn: ({ signal }) => listShufflrrItems(params, { signal }),
    enabled: active && expanded,
    staleTime: 30_000,
  });
}

type ShufflrrBranchProps = {
  folderId?: number;
  level: number;
  active: boolean;
  disabled: boolean;
  expanded: Set<number>;
  toggle: (id: number) => void;
  selected: Map<number, SyncSourceFolder>;
  excluded: Map<number, SyncFolderExclusion>;
  parentIds: number[];
  parentById: Map<number, number>;
  onParentLoaded: (parent: number, children: number[]) => void;
  onSelect: (folder: SyncSourceFolder, parentIds: number[], checked: boolean) => void;
};

function ShufflrrFolderBranch({
  folderId,
  level,
  active,
  disabled,
  expanded,
  toggle,
  selected,
  excluded,
  parentIds,
  parentById,
  onParentLoaded,
  onSelect,
}: ShufflrrBranchProps) {
  const listing = useShufflrrFolders(folderId, active, folderId === undefined || (!!folderId && expanded.has(folderId)));
  const folders = useMemo(() => (listing.data?.items ?? []).filter(item => item.isFolder), [listing.data]);

  useEffect(() => {
    if (folderId !== undefined && listing.data) {
      onParentLoaded(folderId, folders.map(folder => folder.id));
    }
  }, [folderId, listing.data, folders, onParentLoaded]);

  if (listing.isError) {
    return (
      <div className="py-1 text-sm text-destructive" style={{ paddingLeft: `${level * 18}px` }}>
        Could not load Shufflrr folders.
        <button type="button" className="ml-2 underline" onClick={() => void listing.refetch()}>Retry</button>
      </div>
    );
  }
  if (listing.isLoading) {
    return <div className="py-1 text-sm text-muted-foreground" style={{ paddingLeft: `${level * 18}px` }}>…</div>;
  }
  return (
    <div>
      {folders.map(folder => {
        const selection = folderSelectionState(folder.id, parentIds, selected, excluded, parentById);
        const itemOpen = expanded.has(folder.id);
        return (
          <div key={folder.id}>
            <div
              className="flex min-h-9 items-center gap-2 rounded px-1 hover:bg-secondary"
              style={{ paddingLeft: `${level * 18}px` }}
            >
              <button
                type="button"
                className="grid size-7 shrink-0 place-items-center rounded hover:bg-background"
                aria-label={`${itemOpen ? "Collapse" : "Expand"} ${folder.name}`}
                onClick={() => toggle(folder.id)}
              >
                {itemOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
              <input
                type="checkbox"
                checked={selection.checked}
                ref={element => { if (element) element.indeterminate = selection.indeterminate; }}
                aria-checked={selection.indeterminate ? "mixed" : selection.checked}
                disabled={disabled || selection.excludedByAncestor}
                onChange={event => onSelect({ id: folder.id, name: folder.name }, parentIds, event.target.checked)}
                aria-label={`Sync ${folder.name}`}
                title={selection.excludedByAncestor ? "Excluded by parent. Reinclude the parent folder first."
                  : selection.explicitlyExcluded ? "Excluded subtree. Check to include it again."
                  : selection.inherited ? "Included by parent. Uncheck to exclude this folder and its subfolders."
                  : selection.indeterminate ? "Some subfolders are excluded or selected separately." : "Includes all subfolders."}
                className="size-4 accent-primary"
              />
              <Folder className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 truncate text-sm">{folder.name}</span>
              {selection.explicitlyExcluded && <span className="text-xs text-muted-foreground">Excluded</span>}
              {selection.inherited && <span className="text-xs text-muted-foreground">Included</span>}
            </div>
            {itemOpen && (
              <ShufflrrFolderBranch
                folderId={folder.id}
                level={level + 1}
                active={active}
                disabled={disabled}
                expanded={expanded}
                toggle={toggle}
                selected={selected}
                excluded={excluded}
                parentIds={[...parentIds, folder.id]}
                parentById={parentById}
                onParentLoaded={onParentLoaded}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
      {folders.length === 0 && (
        <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: `${(level + 1) * 18}px` }}>No folders</div>
      )}
    </div>
  );
}

const pollingOptions = [
  { value: 1, label: "1 second" },
  { value: 5, label: "5 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "60 seconds" },
  { value: 300, label: "5 minutes" },
  { value: 3600, label: "60 minutes" },
] as const;

function ConfigStatus({ config }: { config: SyncConfig }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const lastRunAt = config.lastRunAt ? new Date(config.lastRunAt) : null;
  const nextRunAt = config.nextRunAt ? new Date(config.nextRunAt) : null;
  const running = config.lastRunStatus === "running";
  const cooldownUntil = config.providerCooldownUntil ? new Date(config.providerCooldownUntil) : null;
  let state: { label: string; tone: string };
  if (!config.configured) state = { label: "No folders connected", tone: "text-muted-foreground" };
  else if (!config.enabled) state = { label: running ? "Finishing active work…" : "Paused", tone: "text-muted-foreground" };
  else if (running) state = { label: "Running now", tone: "text-sky-700" };
  else if (cooldownUntil && cooldownUntil.getTime() > now) {
    state = { label: `Provider cooldown until ${cooldownUntil.toLocaleTimeString()}`, tone: "text-amber-700" };
  } else if (nextRunAt && nextRunAt.getTime() > now) {
    state = { label: `Waiting, next check in ${Math.ceil((nextRunAt.getTime() - now) / 1000)}s`, tone: "text-foreground" };
  } else state = { label: "Due, waiting for worker to start (about 1s)", tone: "text-foreground" };
  const outcome = config.lastRunStatus && config.lastRunStatus !== "running"
    ? { success: "completed", partial: "completed with issues", failed: "failed" }[config.lastRunStatus]
    : null;
  return (
    <div className="rounded-md border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-medium">
          {config.enabled ? "Sync enabled" : "Sync paused"}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            Checks every {pollingOptions.find(option => option.value === config.pollIntervalSeconds)?.label}
          </span>
          <span className={`ml-2 inline-flex items-center gap-1 text-xs font-medium ${state.tone}`} data-testid="status-sync-state">
            {running && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
            {state.label}
          </span>
        </div>
        <span className="text-xs text-muted-foreground" data-testid="sync-last-run">
          {lastRunAt ? `Last run ${lastRunAt.toLocaleString()}${outcome ? ` (${outcome})` : ""}` : "No sync run yet"}
        </span>
      </div>
      {config.lastRunSummary && (
        <div className="mt-2 text-xs text-muted-foreground">
          {config.lastRunSummary.copiedFiles} copied · {config.lastRunSummary.updatedFiles} updated · {config.lastRunSummary.createdFolders} folders created · {config.lastRunSummary.deletedItems} deleted · {config.lastRunSummary.conflicts} conflicts
        </div>
      )}
      {config.lastRunError && (
        <div className="mt-2 text-sm text-destructive" role="alert">{config.lastRunError}</div>
      )}
    </div>
  );
}

export function SyncAgent({ active }: { active: boolean }) {
  const [retryQueuedAt, setRetryQueuedAt] = useState<string | null>(null);
  const configTriggerRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: getGetSyncConfigQueryKey(),
    queryFn: ({ signal }) => getSyncConfigQuery(signal),
    enabled: active,
    staleTime: 10_000,
    refetchInterval: query => !active ? false : query.state.data?.enabled || query.state.data?.lastRunStatus === "running" ? 1000 : Math.min(30_000, (query.state.data?.pollIntervalSeconds ?? 60) * 1000),
  });
  const config = configQuery.data;
  const [destination, setDestination] = useState<{ id: string; name: string } | null>(null);
  const [selected, setSelected] = useState<Map<number, SyncSourceFolder>>(new Map());
  const [excluded, setExcluded] = useState<Map<number, SyncFolderExclusion>>(new Map());
  const [parentById, setParentById] = useState<Map<number, number>>(new Map());
  const [expandedSharePoint, setExpandedSharePoint] = useState<Set<string>>(new Set());
  const [expandedShufflrr, setExpandedShufflrr] = useState<Set<number>>(new Set());
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const reviewIgnored = () => {
    setIgnoredOpen(true);
    setDrawerOpen(false);
    requestAnimationFrame(() => document.getElementById("sync-ignored-files")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const pickersActive = active && drawerOpen;
  const savedFolderSettings = JSON.stringify(config ? {
    destinationFolderId: config.destinationFolderId,
    destinationFolderName: config.destinationFolderName,
    sourceFolders: config.sourceFolders,
    excludedFolders: config.excludedFolders,
  } : null);

  useEffect(() => {
    if (!config) return;
    setDestination(config.destinationFolderId && config.destinationFolderName
      ? { id: config.destinationFolderId, name: config.destinationFolderName }
      : null);
    setSelected(new Map(config.sourceFolders.map(folder => [folder.id, folder])));
    setExcluded(new Map((config.excludedFolders ?? []).map(folder => [folder.id, folder])));
  }, [savedFolderSettings]); // Status refreshes must not discard unsaved folder selections.

  const refreshMutation = useMutation({
    mutationFn: async () => {
      // Reload visible branches, and mark closed branches stale for their next expansion.
      // Keep cached rows rendered while requests run to avoid collapsing or flashing the trees.
      const results = await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["sync-sharepoint-folders"] }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: getListShufflrrItemsQueryKey() }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: getGetSyncConfigQueryKey() }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: getGetSyncDashboardQueryKey() }, { throwOnError: true }),
      ]);
      if (results.some(result => result.status === "rejected")) {
        throw new Error("Some updates could not be loaded. Refresh again or check the folder errors below.");
      }
    },
  });

  const saveMutation = useMutation({
    mutationFn: (input: SyncConfigInput) => saveSyncConfig(input),
    onSuccess: async () => { setDisconnected(false); await queryClient.invalidateQueries({ queryKey: getGetSyncConfigQueryKey() }); },
  });
  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) => setSyncEnabled({ enabled }),
    onSuccess: async updated => {
      // An older in-flight status poll must not undo the newly saved button state.
      await queryClient.cancelQueries({ queryKey: getGetSyncConfigQueryKey() });
      queryClient.setQueryData(getGetSyncConfigQueryKey(), updated);
      await queryClient.invalidateQueries({ queryKey: getGetSyncConfigQueryKey() });
    },
  });
  const intervalMutation = useMutation({
    mutationFn: (pollIntervalSeconds: 1 | 5 | 30 | 60 | 300 | 3600) => setSyncInterval({ pollIntervalSeconds }),
    onSuccess: updated => queryClient.setQueryData(getGetSyncConfigQueryKey(), updated),
  });
  const runNowMutation = useMutation({
    mutationFn: () => requestSyncNow(),
    onSuccess: async updated => {
      await queryClient.cancelQueries({ queryKey: getGetSyncConfigQueryKey() });
      queryClient.setQueryData(getGetSyncConfigQueryKey(), updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetSyncConfigQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetSyncRunsQueryKey() }),
      ]);
    },
    // A worker can start between the last poll and this click. Show its live
    // progress immediately after the server rejects the competing request.
    onError: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetSyncConfigQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetSyncRunsQueryKey() }),
      ]);
    },
  });
  useEffect(() => {
    if (shouldClearBusySyncError(runNowMutation.error, config?.lastRunStatus,
      configQuery.dataUpdatedAt, runNowMutation.submittedAt, config?.lastRunAt)) runNowMutation.reset();
  }, [runNowMutation.error, runNowMutation.reset, runNowMutation.submittedAt,
    config?.lastRunStatus, config?.lastRunAt, configQuery.dataUpdatedAt]);
  const dismissMutation = useMutation({
    mutationFn: (id: number) => dismissSyncOrphan(id),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: getGetSyncConfigQueryKey() }); },
  });
  const disconnectMutation = useMutation({
    mutationFn: () => disconnectSync(),
    onSuccess: async updated => {
      await queryClient.cancelQueries({ queryKey: getGetSyncConfigQueryKey() });
      queryClient.setQueryData(getGetSyncConfigQueryKey(), updated);
      setDestination(null);
      setSelected(new Map());
      setExcluded(new Map());
      setExpandedSharePoint(new Set());
      setExpandedShufflrr(new Set());
      setParentById(new Map());
      setPickerError(null);
      setDisconnected(true);
      saveMutation.reset();
      enabledMutation.reset();
      runNowMutation.reset();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetSyncConfigQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetSyncDashboardQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetSyncFailuresQueryKey() }),
      ]);
    },
  });

  const onParentLoaded = (parent: number, children: number[]) => {
    setParentById(previous => {
      let changed = false;
      const next = new Map(previous);
      for (const child of children) {
        if (next.get(child) !== parent) {
          next.set(child, parent);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  };
  const onSelectSource = (folder: SyncSourceFolder, ancestors: number[], checked: boolean) => {
    setPickerError(null);
    const next = toggleFolderSelection(folder, ancestors, checked, selected, excluded, parentById);
    setSelected(next.roots);
    setExcluded(next.exclusions);
  };

  const saveError = errorText(saveMutation.error);
  const actionError = errorText(intervalMutation.error) ?? errorText(enabledMutation.error) ??
    errorText(runNowMutation.error) ?? errorText(dismissMutation.error);
  const configError = errorText(configQuery.error);
  const foldersLocked = !!config?.enabled || config?.lastRunStatus === "running" || disconnectMutation.isPending;
  const canSave = !!destination && selected.size > 0 && Array.isArray(config?.excludedFolders) && !foldersLocked && !saveMutation.isPending && !intervalMutation.isPending;

  return (
    <div className="space-y-5" data-testid="sync-agent">
      <div className="sticky top-16 z-[1] flex flex-wrap items-center justify-between gap-3 border-b bg-background py-3">
        <h2 className="text-lg font-semibold">Sync Agent</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Shufflrr polling
            <select
              aria-label="Shufflrr polling interval"
              title="Saved automatically. Runs never overlap; provider cooldowns take priority."
              value={config?.pollIntervalSeconds ?? 60}
              disabled={!config || intervalMutation.isPending || saveMutation.isPending || enabledMutation.isPending || disconnectMutation.isPending}
              onChange={event => {
                const option = pollingOptions.find(option => option.value === Number(event.target.value));
                if (option) intervalMutation.mutate(option.value);
              }}
              className="h-9 rounded-md border bg-card px-2 text-sm text-foreground disabled:opacity-50"
              data-testid="select-sync-poll-interval"
            >
              {pollingOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {intervalMutation.isPending && <Loader2 className="size-4 animate-spin" aria-label="Saving polling interval" />}
          </label>
          <button
            type="button"
            onClick={() => runNowMutation.mutate()}
            disabled={!config?.enabled || !config.configured || config.lastRunStatus === "running" ||
              runNowMutation.isPending || saveMutation.isPending || intervalMutation.isPending || enabledMutation.isPending || disconnectMutation.isPending}
            title={!config?.enabled ? "Start sync before requesting an immediate run."
              : config.lastRunStatus === "running" ? "A sync is running. Try Sync now again once it finishes."
                : "Queue a full sync now; provider cooldowns are still respected."}
            aria-busy={runNowMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
            data-testid="button-sync-now"
          >
            <RefreshCw className={`size-4 ${runNowMutation.isPending ? "animate-spin" : ""}`} aria-hidden="true" />
            {runNowMutation.isPending ? "Queueing…" : config?.lastRunStatus === "running" ? "Sync running" : "Sync now"}
          </button>
          <button
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={!active || refreshMutation.isPending || saveMutation.isPending || enabledMutation.isPending || disconnectMutation.isPending}
            aria-busy={refreshMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
            data-testid="button-refresh-sync"
          >
            <RefreshCw className={`size-4 ${refreshMutation.isPending ? "animate-spin" : ""}`} aria-hidden="true" />
            {refreshMutation.isPending ? "Refreshing…" : "Refresh"}
          </button>
        {config && (
          <button
            type="button"
            onClick={() => enabledMutation.mutate(!config.enabled)}
            disabled={!config.configured || !Array.isArray(config.excludedFolders) || enabledMutation.isPending || intervalMutation.isPending || saveMutation.isPending || disconnectMutation.isPending}
            aria-pressed={config.enabled}
            className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${config.enabled ? "border bg-card hover:bg-secondary" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}
            data-testid="button-toggle-sync"
          >
            {enabledMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {enabledMutation.isPending ? "Saving…" : config.enabled ? "Pause sync" : "Start sync"}
          </button>
        )}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            ref={configTriggerRef}
            aria-label="Open sync folder configuration"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            title="Folder configuration"
            className="grid size-9 place-items-center rounded-md border bg-card hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="button-open-sync-config"
          >
            <Settings className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {saveError && <p className="text-sm text-destructive" role="alert">{saveError}</p>}
      {actionError && <p className="text-sm text-destructive" role="alert">{actionError}</p>}
      {refreshMutation.isError && (
        <div className="text-sm text-destructive" role="alert">{errorText(refreshMutation.error)}</div>
      )}
      {configQuery.isLoading && <div className="text-sm text-muted-foreground">Loading sync settings…</div>}
      {configError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {configError}
        </div>
      )}
      {disconnected && !config?.configured && (
        <p className="rounded-md border bg-card px-4 py-3 text-sm" role="status" data-testid="status-sync-disconnected">
          Folders disconnected. Sync is paused. Existing SharePoint files, notices, and history were kept.
          Open folder configuration to save a new mapping.
        </p>
      )}
      {config && <SyncDashboard active={active} config={config} reviewIgnored={reviewIgnored} />}
      {config && <ConfigStatus config={config} />}
      {config && <SyncFailureBanners active={active} onRetryQueued={setRetryQueuedAt} />}
      {config && <SyncIgnoredFiles active={active} open={ignoredOpen} setOpen={setIgnoredOpen} running={config.lastRunStatus === "running"} />}
      {config && <SyncActivityLog config={config} active={active}
        retryQueuedAt={retryQueuedAt} onRetrySelected={() => setRetryQueuedAt(null)} />}
      {config?.enabled && <p className="text-xs text-muted-foreground">Pause sync before changing its folders.</p>}
      {!config?.enabled && config?.lastRunStatus === "running" &&
        <p className="text-xs text-muted-foreground" role="status">Pause saved. Active work will finish safely before stopping; folder settings stay locked until it finishes.</p>}

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="right"
          hideCloseButton
          onCloseAutoFocus={event => {
            event.preventDefault();
            configTriggerRef.current?.focus();
          }}
          className="flex h-[100dvh] w-full flex-col gap-0 overflow-y-auto p-0 motion-reduce:!animate-none sm:max-w-xl md:overflow-hidden"
          data-testid="sheet-sync-config"
        >
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-3">
            <SheetClose
              className="grid size-9 shrink-0 place-items-center rounded-md hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Close folder configuration"
              data-testid="button-close-sync-config"
            >
              <ChevronRight className="size-5" aria-hidden="true" />
            </SheetClose>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-base">Folder configuration</SheetTitle>
              <SheetDescription className="truncate text-xs">
                {foldersLocked ? "Locked while sync is running or enabled." : "Closing keeps your unsaved selections."}
              </SheetDescription>
            </div>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => {
                if (!destination) return;
                saveMutation.mutate({
                  destinationFolderId: destination.id,
                  destinationFolderName: destination.name,
                  sourceFolders: [...selected.values()],
                excludedFolders: [...excluded.values()].map(folder => ({
                  ...folder, ancestorIds: currentExclusionAncestors(folder, parentById),
                })),
                  pollIntervalSeconds: config?.pollIntervalSeconds ?? 60,
                });
              }}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-primary-foreground hover:bg-primary/90 text-sm font-medium  disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="button-save-sync-config"
            >
              {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save settings
            </button>
          </div>
          {saveError && <p className="shrink-0 px-4 pt-3 text-sm text-destructive" role="alert">{saveError}</p>}
          <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
            {config?.ignoredFileCount ?? 0} active file ignore rule{config?.ignoredFileCount === 1 ? "" : "s"} ·{" "}
            <button type="button" className="font-medium underline" onClick={reviewIgnored}>Review ignored files</button>
          </div>
      <div className={`flex min-h-0 flex-1 flex-col gap-3 p-3 ${foldersLocked ? "opacity-70" : ""}`}>
        <section className="flex min-h-[14rem] min-w-0 flex-1 basis-0 flex-col md:min-h-0 rounded-lg border bg-card">
          <div className="shrink-0 border-b px-4 py-3">
            <h3 className="text-sm font-medium">SharePoint Sync Folder</h3>
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <div
              role="region"
              aria-label="SharePoint sync folders"
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-scroll overscroll-contain [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="sync-sharepoint-scroll"
            >
            <button
              type="button"
              disabled={foldersLocked}
              onClick={() => setDestination({ id: "root", name: "Shared Documents" })}
              className={`flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-secondary disabled:cursor-not-allowed ${destination?.id === "root" ? "bg-accent font-medium" : ""}`}
              aria-pressed={destination?.id === "root"}
            >
              <Folder className="size-4 text-primary" />
              Shared Documents root
            </button>
            <div className="mt-1">
              <SharePointFolderBranch
                active={pickersActive}
                level={0}
                disabled={foldersLocked}
                expanded={expandedSharePoint}
                toggle={id => setExpandedSharePoint(previous => {
                  const next = new Set(previous);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
                selectedId={destination?.id ?? null}
                onSelect={setDestination}
              />
            </div>
            </div>
            {destination && (
              <div className="mt-3 shrink-0 border-t pt-3 text-xs text-muted-foreground">
                Selected: <span className="font-medium text-foreground">{destination.name}</span>
              </div>
            )}
          </div>
        </section>

        <section className="flex min-h-[14rem] min-w-0 flex-1 basis-0 flex-col md:min-h-0 rounded-lg border bg-card">
          <div className="shrink-0 border-b px-4 py-3">
            <h3 className="text-sm font-medium">Shufflrr folders</h3>
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <div
              role="region"
              aria-label="Shufflrr sync folders"
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-scroll overscroll-contain [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="sync-shufflrr-scroll"
            >
            <ShufflrrFolderBranch
              active={pickersActive}
              level={0}
              disabled={foldersLocked}
              expanded={expandedShufflrr}
              toggle={id => setExpandedShufflrr(previous => {
                const next = new Set(previous);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })}
              selected={selected}
              excluded={excluded}
              parentIds={[]}
              parentById={parentById}
              onParentLoaded={onParentLoaded}
              onSelect={onSelectSource}
            />
            </div>
            <div className="mt-3 shrink-0 border-t pt-3 text-xs text-muted-foreground">
              {selected.size} root folder{selected.size === 1 ? "" : "s"} selected · includes subfolders
              {excluded.size > 0 && ` · ${excluded.size} subtree${excluded.size === 1 ? "" : "s"} excluded`}
            </div>
          </div>
        </section>
      </div>

            {pickerError && <div className="text-sm text-destructive" role="alert">{pickerError}</div>}

          <SyncDisconnectControl
            config={config}
            busy={disconnectMutation.isPending}
            blockedReason={config?.enabled ? "Pause sync before disconnecting its folders."
              : config?.lastRunStatus === "running" ? "Wait for the active sync run to finish."
                : saveMutation.isPending || intervalMutation.isPending || enabledMutation.isPending || runNowMutation.isPending
                  ? "Wait for the current settings change to finish." : null}
            error={errorText(disconnectMutation.error)}
            onConfirm={async () => { await disconnectMutation.mutateAsync(); }}
          />
        </SheetContent>
      </Sheet>

      {config?.detachedPairs.length ? (
        <section className="rounded-lg border bg-card p-4" aria-labelledby="sync-detached-heading">
          <h3 id="sync-detached-heading" className="text-sm font-medium">No longer syncing</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            These copies remain in SharePoint. Delete them manually if they are no longer needed.
          </p>
          <ul className="mt-3 divide-y">
            {config.detachedPairs.map(pair => (
              <li key={pair.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 break-words">
                  {pair.sourceRootName} <span className="text-muted-foreground">→</span> {pair.destinationFolderName}/{pair.sourceRootName}
                </span>
                <button
                  type="button"
                  onClick={() => dismissMutation.mutate(pair.id)}
                  disabled={dismissMutation.isPending}
                  aria-label={`Dismiss ${pair.sourceRootName} to ${pair.destinationFolderName}`}
                  className="grid size-8 shrink-0 place-items-center rounded hover:bg-secondary disabled:opacity-50"
                >
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

async function getSyncConfigQuery(signal: AbortSignal): Promise<SyncConfig> {
  return getSyncConfig({ signal });
}
