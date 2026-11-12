import { createHash } from "node:crypto";
import type { SyncFolderExclusion, SyncInventorySnapshot, SyncItem, SyncSourceFolder, SyncEventStatus } from "@workspace/db/schema";
import type { Entry } from "@workspace/shufflrr";
import type { SyncDriveItem } from "./sharepoint";

interface Scope {
  destinationFolderId: string;
  sourceFolders: SyncSourceFolder[];
  excludedFolders?: SyncFolderExclusion[];
}
interface SourceFile { root: SyncSourceFolder; entry: Entry; path: string }
type DestinationFile = SyncDriveItem & { path: string };
type Outcome = "synchronized" | "failed" | "pending";

/** Stable across interval/pause changes, but never shared between different folder scopes. */
export function syncInventoryScopeKey(scope: Scope): string {
  return createHash("sha256").update(JSON.stringify({
    destination: scope.destinationFolderId,
    roots: scope.sourceFolders.map(root => root.id).sort((a, b) => a - b),
    excluded: (scope.excludedFolders ?? []).map(folder => `${folder.rootId}:${folder.id}`).sort(),
  })).digest("hex");
}

/** Incremental O(1) per outcome; totals count files, never folders or repeated notice occurrences. */
export class SyncInventory {
  readonly totals: SyncInventorySnapshot;
  private readonly files = new Map<string, { outcome: Outcome; storedBytes: number }>();

  constructor(scope: Scope, sources: SourceFile[], mappings: SyncItem[], destinations: DestinationFile[]) {
    this.totals = {
      scopeKey: syncInventoryScopeKey(scope), scannedAt: new Date().toISOString(),
      sourceFiles: 0, sourceBytes: 0, sourceUnknownSizeFiles: 0,
      synchronizedFiles: 0, synchronizedBytes: 0,
      failedFiles: 0, pendingFiles: 0, notSynchronizedFiles: 0,
    };
    const bySource = new Map(mappings.filter(item => !item.sourceIsFolder &&
      item.destinationRootId === scope.destinationFolderId).map(item => [`${item.sourceRootId}:${item.sourceId}`, item]));
    const byDestination = new Map(destinations.map(item => [item.id, item]));
    for (const source of sources) {
      if (source.entry.isFolder) continue;
      const key = `${source.root.id}:${source.entry.id}`;
      if (this.files.has(key)) continue;
      this.totals.sourceFiles++;
      if (source.entry.size === undefined) this.totals.sourceUnknownSizeFiles++;
      else this.totals.sourceBytes += source.entry.size;
      const mapping = bySource.get(key);
      const destination = mapping && byDestination.get(mapping.destinationId);
      const synchronized = !!mapping && !!destination && !destination.isFolder &&
        mapping.relativePath === source.path && destination.path === source.path &&
        mapping.name === source.entry.name && destination.name === source.entry.name &&
        mapping.sourceSize === (source.entry.size ?? 0) &&
        mapping.sourceModifiedAt === (source.entry.modifiedAt ?? null) &&
        !!mapping.destinationCTag && mapping.destinationCTag === destination.cTag;
      this.files.set(key, { outcome: "pending", storedBytes: 0 });
      this.totals.pendingFiles++;
      this.totals.notSynchronizedFiles++;
      if (synchronized) this.set(key, "synchronized", destination!.size);
    }
  }

  record(rootId: number, sourceId: number, status: SyncEventStatus, destination?: SyncDriveItem): void {
    const key = `${rootId}:${sourceId}`;
    if (status === "failed" || status === "conflict") this.set(key, "failed", 0);
    else if (status === "skipped") this.set(key, "pending", 0);
    else if (["copied", "updated", "unchanged", "moved"].includes(status) && destination && !destination.isFolder)
      this.set(key, "synchronized", destination.size);
  }

  private set(key: string, outcome: Outcome, storedBytes: number): void {
    const previous = this.files.get(key);
    if (!previous) return;
    const counter = { synchronized: "synchronizedFiles", failed: "failedFiles", pending: "pendingFiles" } as const;
    this.totals[counter[previous.outcome]]--;
    this.totals[counter[outcome]]++;
    this.totals.synchronizedBytes += (outcome === "synchronized" ? storedBytes : 0) -
      (previous.outcome === "synchronized" ? previous.storedBytes : 0);
    this.totals.notSynchronizedFiles = this.totals.failedFiles + this.totals.pendingFiles;
    this.files.set(key, { outcome, storedBytes });
  }
}
