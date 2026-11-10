import { and, eq, inArray, notInArray, isNull, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import { ProviderBackoffError } from "@workspace/shufflrr/http-policy";
import { loadDestinationSnapshot } from "./sharepoint-snapshot";
import { SyncRunJournal, type SyncReporter } from "./sync-log";
import { excludedMappingIds } from "./sync-exclusions";
import { FileTransferError, sourceFileStream } from "./sync-transfer";
import { SyncFileFailureStore } from "./sync-file-failures";
import {
  syncConfigTable,
  syncItemsTable,
  syncSharepointItemsTable,
  type SyncConflict,
  type SyncRunSummary,
  type SyncSourceFolder,
  type SyncEventStatus,
  type SyncFolderExclusion,
  syncFileFailuresTable,
} from "@workspace/db/schema";
import { ShufflrrClient, ShufflrrError, type Entry } from "@workspace/shufflrr";
import { newShufflrrClient, shufflrrConfig } from "./shufflrr";
import {
  AccessError,
  createSyncFolder,
  deleteSyncItem,
  updateSyncItem,
  uploadSyncFile,
  type SyncDriveItem,
} from "./sharepoint";

export const SYNC_LOCK_ID = 74120937;
const MAX_SOURCE_FOLDERS = 5_000;
const MAX_TOTAL_ITEMS = 100_000;
const MAX_DEPTH = 100;
const MAX_CONFLICTS_TO_STORE = 500;

interface SourceRecord {
  root: SyncSourceFolder;
  entry: Entry;
  parentSourceId: string | null;
  path: string;
  depth: number;
}

interface DestinationRecord extends SyncDriveItem {
  path: string;
}

interface SyncResult {
  skipped: boolean;
  nextCheckMs?: number;
  status?: "success" | "partial";
  summary?: SyncRunSummary;
}

function sourceKey(rootId: string, itemId: string, isFolder: boolean): string {
  return `${rootId}:${isFolder ? "folder" : "file"}:${itemId}`;
}

function pathKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function safeError(error: unknown): string {
  if (error instanceof FileTransferError) return error.message;
  if (error instanceof ProviderBackoffError) return "The provider requested a cooldown. Sync will resume after the required delay.";
  if (error instanceof ShufflrrError) {
    if (error.code === "throttled") return "Shufflrr requested a cooldown. Sync will resume after the required delay.";
    if (error.code === "configuration") return "Shufflrr is not configured on the server.";
    if (error.code === "authentication") return "Shufflrr authentication failed.";
    if (error.code === "permission") return "The Shufflrr service account cannot read a selected folder.";
    if (error.code === "limit") return "A selected Shufflrr folder exceeded a sync safety limit.";
  }
  if (error instanceof AccessError) {
    if (error.status === 401 || error.status === 403) return "SharePoint denied a sync operation. Check write access to the selected folder.";
    if (error.status === 404) return "The SharePoint destination or a managed item could not be found.";
    if (error.status === 409 || error.code === "SyncConflict") return "A SharePoint item changed during sync and was left unchanged.";
    if (error.status === 413 || error.code === "SyncLimit") return "A file or folder exceeded the SharePoint sync safety limit.";
    if (error.status === 429) return "SharePoint throttled this sync run. It will be retried at the next scheduled check.";
    if (error.status === 400) return "SharePoint rejected a sync operation. Check file and folder names and the server log reference.";
  }
  if (error instanceof Error) {
    // Only return messages defined by the runner; provider/database errors can contain sensitive data.
    const knownMessages = [
      "A Shufflrr folder cycle was detected.",
      "The Shufflrr folder limit was reached.",
      "The Shufflrr nesting limit was reached.",
      "The Shufflrr item limit was reached.",
      "Selected Shufflrr folders overlap. Select a parent or its nested folder, not both.",
      "The SharePoint destination exceeded a sync safety limit.",
      "A SharePoint folder cycle was detected.",
      "A selected destination folder could not be resolved.",
      "A Shufflrr file download failed.",
      "A Shufflrr file exceeds the 300 MB sync limit.",
      "A SharePoint item could not be created or resolved.",
      "The shared sync configuration is incomplete.",
    ];
    if (knownMessages.includes(error.message)) return error.message;
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "A provider request timed out. The next scheduled check will retry the sync.";
    }
  }
  return "The sync run could not complete. Check the provider connections and permissions.";
}

type SyncPhase = "configuration" | "authentication" | "source_listing" | "destination_listing" | "reconciliation" | "save_status";

function diagnosticCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = "code" in error ? error.code : undefined;
  return typeof value === "string" && /^[a-zA-Z0-9_]{1,64}$/.test(value) ? value : undefined;
}

function retryDate(error: unknown): Date | undefined {
  return error instanceof ProviderBackoffError || error instanceof ShufflrrError ? error.retryAt : undefined;
}

async function loadSourceTree(client: ShufflrrClient, roots: SyncSourceFolder[], exclusions: SyncFolderExclusion[]) {
  const records: SourceRecord[] = [];
  const excludedRecords: SourceRecord[] = [];
  const excludedKeys = new Set(exclusions.map(folder => `${folder.rootId}:${folder.id}`));
  const foldersVisited = new Set<string>();
  const selectedRootIds = new Set(roots.map(root => String(root.id)));

  for (const configuredRoot of roots) {
    const rootEntry = await client.folder(configuredRoot.id);
    const currentRoot = { id: rootEntry.id, name: rootEntry.name };
    records.push({
      root: currentRoot,
      entry: rootEntry,
      parentSourceId: null,
      path: rootEntry.name,
      depth: 0,
    });
    const queue: Array<{ folderId: number; parentId: string; path: string; depth: number }> = [{
      folderId: rootEntry.id,
      parentId: String(rootEntry.id),
      path: rootEntry.name,
      depth: 1,
    }];

    while (queue.length) {
      const current = queue.shift()!;
      const key = `${configuredRoot.id}:${current.folderId}`;
      if (foldersVisited.has(key)) throw new Error("A Shufflrr folder cycle was detected.");
      foldersVisited.add(key);
      if (foldersVisited.size > MAX_SOURCE_FOLDERS) throw new Error("The Shufflrr folder limit was reached.");
      if (current.depth > MAX_DEPTH) throw new Error("The Shufflrr nesting limit was reached.");

      const children = await client.contents(current.folderId);
      for (const entry of children) {
        if (records.length >= MAX_TOTAL_ITEMS) throw new Error("The Shufflrr item limit was reached.");
        const path = `${current.path}/${entry.name}`;
        if (entry.isFolder && excludedKeys.has(`${configuredRoot.id}:${entry.id}`)) {
          excludedRecords.push({
            root: currentRoot, entry, parentSourceId: current.parentId, path, depth: current.depth,
          });
          continue;
        }
        records.push({
          root: currentRoot,
          entry,
          parentSourceId: current.parentId,
          path,
          depth: current.depth,
        });
        if (entry.isFolder) {
          if (selectedRootIds.has(String(entry.id)) && entry.id !== configuredRoot.id) {
            throw new Error("Selected Shufflrr folders overlap. Select a parent or its nested folder, not both.");
          }
          queue.push({
            folderId: entry.id,
            parentId: String(entry.id),
            path,
            depth: current.depth + 1,
          });
        }
      }
    }
  }

  return { records, excludedRecords };
}

function destinationPathIndex(records: DestinationRecord[]): Map<string, DestinationRecord> {
  const index = new Map<string, DestinationRecord>();
  for (const record of records) index.set(pathKey(record.path), record);
  return index;
}

function replaceDestinationPath(
  records: Map<string, DestinationRecord>,
  record: DestinationRecord,
  next: SyncDriveItem,
  nextPath: string,
): DestinationRecord {
  const previousPath = record.path;
  const updated: DestinationRecord = { ...record, ...next, path: nextPath };
  for (const current of records.values()) {
    if (current.id === record.id) continue;
    if (current.path.startsWith(`${previousPath}/`)) {
      current.path = `${nextPath}${current.path.slice(previousPath.length)}`;
    }
  }
  records.set(updated.id, updated);
  return updated;
}

function rebuildDestinationPathIndex(records: Map<string, DestinationRecord>): Map<string, DestinationRecord> {
  return new Map([...records.values()].map(record => [pathKey(record.path), record]));
}

function addConflict(
  list: SyncConflict[],
  keys: Set<string>,
  path: string,
  kind: SyncConflict["kind"],
): void {
  const key = `${kind}:${pathKey(path)}`;
  if (keys.has(key)) return;
  keys.add(key);
  if (list.length < MAX_CONFLICTS_TO_STORE) list.push({ path, kind });
}

async function saveRunState(
  db: typeof import("@workspace/db")["db"],
  values: {
    status: "success" | "partial" | "failed";
    summary: SyncRunSummary | null;
    conflicts: SyncConflict[];
    error: string | null;
    retryAt?: Date;
  },
): Promise<void> {
  await db.update(syncConfigTable).set({
    lastRunAt: new Date(),
    lastRunStatus: values.status,
    lastRunSummary: values.summary,
    lastRunConflicts: values.conflicts,
    lastRunError: values.error,
    nextRunAt: sql`greatest(now() + ${syncConfigTable.pollIntervalSeconds} * interval '1 second', ${values.retryAt ?? new Date(0)}::timestamptz)`,
    providerRetryAt: values.retryAt ?? null,
  }).where(eq(syncConfigTable.id, 1));
}

export async function performSync(
  db: typeof import("@workspace/db")["db"],
  client: ShufflrrClient,
  config: {
    destinationFolderId: string;
    destinationFolderName: string;
    sourceFolders: SyncSourceFolder[];
    excludedFolders?: SyncFolderExclusion[];
    retryTargets?: Array<{ sourceRootId: number; sourceId: number }>;
  },
  onPhase: (phase: SyncPhase) => void,
  providers = { loadDestinationSnapshot, createSyncFolder, updateSyncItem, uploadSyncFile, deleteSyncItem },
  reporter: SyncReporter = { record: async () => {}, progress: () => {} },
): Promise<{ summary: SyncRunSummary; conflicts: SyncConflict[] }> {
  onPhase("source_listing");
  const exclusions = config.excludedFolders ?? [];
  const rootsToScan = config.retryTargets
    ? config.sourceFolders.filter(root => config.retryTargets!.some(target => target.sourceRootId === root.id))
    : config.sourceFolders;
  const { records: allSourceRecords, excludedRecords } = await loadSourceTree(client, rootsToScan, exclusions);
  const retryKeys = config.retryTargets && new Set(config.retryTargets.map(item => `${item.sourceRootId}:${item.sourceId}`));
  const retryFiles = retryKeys && allSourceRecords.filter(record => !record.entry.isFolder &&
    retryKeys.has(`${record.root.id}:${record.entry.id}`));
  if (retryKeys && retryFiles?.length !== retryKeys.size)
    throw new FileTransferError("A requested file is no longer in the selected sync scope, or is excluded. Refresh the folders or dismiss this notice.");
  const sourceRecords = !retryKeys ? allSourceRecords : allSourceRecords.filter(record =>
    retryFiles!.includes(record) || (record.entry.isFolder && retryFiles!.some(file =>
      file.root.id === record.root.id && file.path.startsWith(`${record.path}/`))));
  const sourceRootIds = config.sourceFolders.map(folder => String(folder.id));
  onPhase("destination_listing");
  const { root: destinationRoot, records: initialDestinations, driveId } = await providers.loadDestinationSnapshot(db, config.destinationFolderId);
  const destinationById = new Map(initialDestinations.map(item => [item.id, item]));
  const destinationByPath = destinationPathIndex(initialDestinations);
  onPhase("reconciliation");

  const existingMappings = await db.select().from(syncItemsTable).where(and(
    eq(syncItemsTable.destinationRootId, config.destinationFolderId),
    inArray(syncItemsTable.sourceRootId, sourceRootIds),
  ));
  const allMappingsForDestination = await db.select().from(syncItemsTable).where(
    eq(syncItemsTable.destinationRootId, config.destinationFolderId),
  );
  const protectedMappingIds = excludedMappingIds(existingMappings, exclusions);
  const protectedMappings = existingMappings.filter(mapping => protectedMappingIds.has(mapping.id));
  const excludedDestinationIds = new Set(protectedMappings.map(mapping => mapping.destinationId));
  const excludedPaths = new Set(excludedRecords.map(record => pathKey(record.path)));
  for (const item of initialDestinations) {
    const path = pathKey(item.path);
    const parts = path.split("/");
    if (parts.some((_, index) => excludedPaths.has(parts.slice(0, index + 1).join("/")))) {
      excludedDestinationIds.add(item.id);
    }
    let parentId = item.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (excludedDestinationIds.has(parentId)) { excludedDestinationIds.add(item.id); break; }
      visited.add(parentId);
      parentId = destinationById.get(parentId)?.parentId;
    }
  }
  const detachedDestinationIds = new Set(allMappingsForDestination
    .filter(item => !sourceRootIds.includes(item.sourceRootId))
    .map(item => item.destinationId));
  const mappingBySource = new Map(existingMappings.map(mapping => [
    sourceKey(mapping.sourceRootId, mapping.sourceId, mapping.sourceIsFolder),
    mapping,
  ]));
  const conflicts: SyncConflict[] = [];
  const conflictKeys = new Set<string>();
  const conflictDestinationIds = new Set<string>();
  const blockedSourceFolders = new Set<string>();
  const liveSourceKeys = new Set<string>();
  const mappedDestinationIds = new Set<string>();
  const summary: SyncRunSummary = {
    createdFolders: 0,
    copiedFiles: 0,
    updatedFiles: 0,
    deletedItems: 0,
    conflicts: 0,
  };
  reporter.progress(summary, conflicts);
  const sourceByPath = new Map(sourceRecords.map(record => [record.path, record]));
  const sourceFoldersById = new Map(allSourceRecords.filter(record => record.entry.isFolder)
    .map(record => [`${record.root.id}:${record.entry.id}`, record]));
  const recordEvent = (path: string, isFolder: boolean, status: SyncEventStatus, message: string) => {
    const record = isFolder ? undefined : sourceByPath.get(path);
    const ancestorIds: number[] = [];
    let parent = record ? record.parentSourceId : null;
    while (parent && ancestorIds.length <= 100) {
      ancestorIds.unshift(Number(parent));
      parent = sourceFoldersById.get(`${record!.root.id}:${parent}`)?.parentSourceId ?? null;
    }
    return reporter.record({
      ...(record ? { sourceFile: { id: record.entry.id, rootId: record.root.id,
        parentId: Number(record.parentSourceId), name: record.entry.name,
        fileHistoryId: record.entry.fileHistoryId,
        ancestorIds, modifiedAt: record.entry.modifiedAt, size: record.entry.size } } : {}),
      path, destinationPath: `${config.destinationFolderName}/${path}`,
      itemType: isFolder ? "folder" : "file", status, message,
    });
  };
  const recordConflict = async (path: string, isFolder: boolean, kind: SyncConflict["kind"]) => {
    const previousCount = conflictKeys.size;
    addConflict(conflicts, conflictKeys, path, kind);
    summary.conflicts = conflictKeys.size;
    if (previousCount !== conflictKeys.size) {
      if (kind === "untracked-sharepoint-item") await reporter.record({
        path: null, destinationPath: `${config.destinationFolderName}/${path}`,
        itemType: isFolder ? "folder" : "file", status: "conflict",
        message: "This SharePoint-only item is not managed by sync. It was left untouched.",
      });
      else await recordEvent(path, isFolder, "conflict",
        "An existing SharePoint item occupies this path. It was left unchanged and was not adopted into sync.");
    }
  };
  for (const record of excludedRecords) {
    await recordEvent(record.path, true, "skipped",
      "Excluded by configuration, including all subfolders and files. Existing SharePoint copies are kept.");
  }
  const loggedExclusions = new Set(excludedRecords.map(record => `${record.root.id}:${record.entry.id}`));
  for (const mapping of protectedMappings) {
    if (mapping.sourceIsFolder && loggedExclusions.has(`${mapping.sourceRootId}:${mapping.sourceId}`)) continue;
    await recordEvent(mapping.relativePath, mapping.sourceIsFolder, "skipped",
      "This copy is inside an excluded subtree and is no longer synchronized. It was left unchanged.");
  }

  for (const [recordIndex, record] of sourceRecords.entries()) {
    try {
    let itemStatus: SyncEventStatus = "unchanged";
    const rootId = String(record.root.id);
    const itemId = String(record.entry.id);
    const key = sourceKey(rootId, itemId, record.entry.isFolder);
    liveSourceKeys.add(key);
    const mapping = mappingBySource.get(key);
    if (mapping) mappedDestinationIds.add(mapping.destinationId);
    if (record.parentSourceId && blockedSourceFolders.has(`${rootId}:${record.parentSourceId}`)) {
      if (record.entry.isFolder) blockedSourceFolders.add(`${rootId}:${itemId}`);
      await recordEvent(record.path, record.entry.isFolder, "skipped", "Not synced because a parent folder has a conflict.");
      continue;
    }

    const parentDestinationId = record.parentSourceId
      ? mappingBySource.get(sourceKey(rootId, record.parentSourceId, true))?.destinationId
      : destinationRoot.id;
    if (!parentDestinationId) throw new Error("A selected destination folder could not be resolved.");

    let destinationItem = mapping ? destinationById.get(mapping.destinationId) : undefined;
    const originalDestination = destinationItem;
    const hadDestination = !!destinationItem;
    const existingAtPath = destinationByPath.get(pathKey(record.path));

    if (!mapping && existingAtPath) {
      await recordConflict(record.path, record.entry.isFolder, "path-conflict");
      conflictDestinationIds.add(existingAtPath.id);
      if (existingAtPath.isFolder) {
        for (const destination of initialDestinations) {
          if (destination.path.startsWith(`${existingAtPath.path}/`)) conflictDestinationIds.add(destination.id);
        }
      }
      if (record.entry.isFolder) blockedSourceFolders.add(`${rootId}:${itemId}`);
      continue;
    }

    if (mapping && destinationItem) {
      const needsMove = destinationItem.parentId !== parentDestinationId || destinationItem.name !== record.entry.name;
      if (needsMove) {
        try {
          const moved = await providers.updateSyncItem(destinationItem.id, {
            name: record.entry.name,
            parentId: parentDestinationId,
          });
          itemStatus = "moved";
          destinationByPath.delete(pathKey(destinationItem.path));
          destinationItem = replaceDestinationPath(
            destinationById,
            destinationItem,
            moved,
            record.path,
          );
          const rebuilt = rebuildDestinationPathIndex(destinationById);
          destinationByPath.clear();
          for (const [path, item] of rebuilt) destinationByPath.set(path, item);
        } catch (error) {
          if (error instanceof AccessError && (error.status === 409 || error.status === 412)) {
            await recordConflict(record.path, record.entry.isFolder, "path-conflict");
            if (record.entry.isFolder) blockedSourceFolders.add(`${rootId}:${itemId}`);
            continue;
          }
          throw error;
        }
      }
    } else if (!destinationItem) {
      if (record.entry.isFolder) {
        try {
          destinationItem = {
            ...await providers.createSyncFolder(parentDestinationId, record.entry.name),
            path: record.path,
          };
          summary.createdFolders += 1;
          itemStatus = "created";
        } catch (error) {
          if (error instanceof AccessError && (error.status === 409 || error.status === 412 || error.code === "SyncConflict")) {
            await recordConflict(record.path, true, "path-conflict");
            if (record.entry.isFolder) blockedSourceFolders.add(`${rootId}:${itemId}`);
            continue;
          }
          throw error;
        }
      } else {
        const upstream = await client.download(record.entry.id);
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel().catch(() => {});
          throw new Error("A Shufflrr file download failed.");
        }
        try {
          destinationItem = {
            ...await providers.uploadSyncFile(parentDestinationId, record.entry.name, sourceFileStream(upstream, record.entry.size)),
            path: record.path,
          };
          summary.copiedFiles += 1;
          itemStatus = "copied";
        } catch (error) {
          if (error instanceof AccessError && (error.status === 409 || error.status === 412 || error.code === "SyncConflict")) {
            await recordConflict(record.path, false, "path-conflict");
            continue;
          }
          throw error;
        } finally {
          await upstream.body?.cancel().catch(() => {});
        }
      }
    }
    if (mapping && hadDestination && destinationItem && !record.entry.isFolder) {
      const destinationChanged = !!mapping?.destinationCTag && !!destinationItem.cTag &&
        mapping.destinationCTag !== destinationItem.cTag;
      const sourceChanged = mapping?.sourceModifiedAt !== (record.entry.modifiedAt ?? null) ||
        mapping?.sourceSize !== (record.entry.size ?? 0);
      if (sourceChanged || destinationChanged || !mapping?.destinationCTag) {
        const upstream = await client.download(record.entry.id);
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel().catch(() => {});
          throw new Error("A Shufflrr file download failed.");
        }
        try {
          destinationItem = {
            ...await providers.uploadSyncFile(parentDestinationId, record.entry.name,
              sourceFileStream(upstream, record.entry.size), destinationItem.id), path: record.path,
          };
        } finally { await upstream.body?.cancel().catch(() => {}); }
        summary.updatedFiles += 1;
        itemStatus = "updated";
      }
    }

    if (!destinationItem) throw new Error("A SharePoint item could not be created or resolved.");
    // Reflect successful local writes immediately, even if Graph's delta feed has not caught up yet.
    if (destinationItem !== originalDestination) {
      await db.insert(syncSharepointItemsTable).values({
        driveId, itemId: destinationItem.id, item: destinationItem,
      }).onConflictDoUpdate({
        target: [syncSharepointItemsTable.driveId, syncSharepointItemsTable.itemId],
        set: { item: destinationItem },
      });
    }
    mappedDestinationIds.add(destinationItem.id);
    const previousDestination = destinationById.get(destinationItem.id);
    if (previousDestination) destinationByPath.delete(pathKey(previousDestination.path));
    destinationById.set(destinationItem.id, { ...destinationItem, path: record.path });
    destinationByPath.set(pathKey(record.path), destinationById.get(destinationItem.id)!);
    if (mapping && mapping.destinationId === destinationItem.id &&
      mapping.sourceRootName === record.root.name && mapping.sourceParentId === record.parentSourceId &&
      mapping.destinationRootName === config.destinationFolderName && mapping.relativePath === record.path &&
      mapping.name === record.entry.name && mapping.sourceModifiedAt === (record.entry.modifiedAt ?? null) &&
      mapping.sourceSize === (record.entry.size ?? 0) && mapping.destinationCTag === (destinationItem.cTag ?? null)) {
      await recordEvent(record.path, record.entry.isFolder, itemStatus, itemStatus === "unchanged"
        ? "Already in sync; no changes needed." : "SharePoint now matches the source.");
      continue;
    }
    const [savedMapping] = await db.insert(syncItemsTable).values({
      sourceRootId: rootId,
      sourceRootName: record.root.name,
      sourceId: itemId,
      sourceIsFolder: record.entry.isFolder,
      sourceParentId: record.parentSourceId,
      destinationRootId: config.destinationFolderId,
      destinationRootName: config.destinationFolderName,
      destinationId: destinationItem.id,
      relativePath: record.path,
      name: record.entry.name,
      sourceModifiedAt: record.entry.modifiedAt ?? null,
      sourceSize: record.entry.size ?? 0,
      destinationCTag: destinationItem.cTag ?? null,
    }).onConflictDoUpdate({
      target: [
        syncItemsTable.sourceRootId,
        syncItemsTable.sourceId,
        syncItemsTable.sourceIsFolder,
        syncItemsTable.destinationRootId,
      ],
      set: {
        sourceRootName: record.root.name,
        sourceParentId: record.parentSourceId,
        destinationRootName: config.destinationFolderName,
        destinationId: destinationItem.id,
        relativePath: record.path,
        name: record.entry.name,
        sourceModifiedAt: record.entry.modifiedAt ?? null,
        sourceSize: record.entry.size ?? 0,
        destinationCTag: destinationItem.cTag ?? null,
        updatedAt: new Date(),
      },
    }).returning();
    mappingBySource.set(key, savedMapping);
    await recordEvent(record.path, record.entry.isFolder, itemStatus, {
      created: "Folder created in SharePoint.",
      copied: "File copied to SharePoint.",
      updated: "SharePoint file updated from the source; its name and location were reconciled.",
      moved: "SharePoint item moved or renamed to match the source.",
      unchanged: "Already in sync; no changes needed.",
      deleted: "", conflict: "", failed: "", skipped: "",
    }[itemStatus]);
    } catch (error) {
      await recordEvent(record.path, record.entry.isFolder, "failed", safeError(error));
      // Fail closed: no more provider writes or mirror deletions after an incomplete run.
      // Explicitly account for every enumerated source item that was not attempted.
      for (const remaining of sourceRecords.slice(recordIndex + 1)) {
        await recordEvent(remaining.path, remaining.entry.isFolder, "skipped",
          "Not attempted because this run stopped after an error. It will be retried on a later run.");
      }
      throw error;
    }
  }

  const staleCandidates = retryKeys ? [] : existingMappings.filter(mapping =>
    !protectedMappingIds.has(mapping.id) &&
    !liveSourceKeys.has(sourceKey(mapping.sourceRootId, mapping.sourceId, mapping.sourceIsFolder)),
  );
  // Deleting an ancestor would recursively delete excluded or otherwise unmanaged copies.
  const allManagedIds = new Set(allMappingsForDestination.map(mapping => mapping.destinationId));
  const deletionProtectedIds = new Set([
    ...excludedDestinationIds, ...detachedDestinationIds,
    ...initialDestinations.filter(item => !allManagedIds.has(item.id)).map(item => item.id),
  ]);
  const protectedAncestorDestinations = new Set<string>();
  for (const id of deletionProtectedIds) {
    let parent = destinationById.get(id)?.parentId;
    while (parent && parent !== destinationRoot.id && !protectedAncestorDestinations.has(parent)) {
      protectedAncestorDestinations.add(parent);
      parent = destinationById.get(parent)?.parentId;
    }
  }
  const preservedAncestorIds = new Set(staleCandidates.filter(mapping =>
    mapping.sourceIsFolder && protectedAncestorDestinations.has(mapping.destinationId)).map(mapping => mapping.id));
  for (const mapping of staleCandidates.filter(item => preservedAncestorIds.has(item.id))) {
    await recordEvent(mapping.relativePath, true, "skipped",
      "Folder retained because deleting it would also delete excluded or unmanaged SharePoint copies.");
  }
  const staleMappings = staleCandidates.filter(mapping => !preservedAncestorIds.has(mapping.id));
  const staleFolderKeys = new Set(staleMappings
    .filter(mapping => mapping.sourceIsFolder)
    .map(mapping => `${mapping.sourceRootId}:${mapping.sourceId}`));
  const deletedDestinationIds = new Set<string>();
  const deletionEvents = new Set<string>();

  for (const mapping of staleMappings) {
    try {
    if (mapping.sourceIsFolder) {
      let parent = mapping.sourceParentId;
      let coveredByMissingFolder = false;
      while (parent) {
        if (staleFolderKeys.has(`${mapping.sourceRootId}:${parent}`)) {
          coveredByMissingFolder = true;
          break;
        }
        const parentMapping = existingMappings.find(item =>
          item.sourceRootId === mapping.sourceRootId && item.sourceIsFolder && item.sourceId === parent,
        );
        parent = parentMapping?.sourceParentId ?? null;
      }
      if (coveredByMissingFolder) continue;
    } else {
      let parent = mapping.sourceParentId;
      let coveredByMissingFolder = false;
      while (parent) {
        if (staleFolderKeys.has(`${mapping.sourceRootId}:${parent}`)) {
          coveredByMissingFolder = true;
          break;
        }
        const parentMapping = existingMappings.find(item =>
          item.sourceRootId === mapping.sourceRootId && item.sourceIsFolder && item.sourceId === parent,
        );
        parent = parentMapping?.sourceParentId ?? null;
      }
      if (coveredByMissingFolder) continue;
    }

    if (destinationById.has(mapping.destinationId)) {
      await providers.deleteSyncItem(mapping.destinationId);
      summary.deletedItems += 1;
      await recordEvent(mapping.relativePath, mapping.sourceIsFolder, "deleted",
        "Managed SharePoint copy deleted because the source item no longer exists.");
      deletionEvents.add(mapping.destinationId);
      const destinationPath = destinationById.get(mapping.destinationId)?.path;
      for (const [id, item] of destinationById) {
        if (id === mapping.destinationId || (destinationPath && item.path.startsWith(`${destinationPath}/`))) {
          deletedDestinationIds.add(id);
          destinationById.delete(id);
        }
      }
    }
    } catch (error) {
      await recordEvent(mapping.relativePath, mapping.sourceIsFolder, "failed", safeError(error));
      throw error;
    }
  }
  for (const mapping of staleMappings) {
    if (deletionEvents.has(mapping.destinationId)) continue;
    await recordEvent(mapping.relativePath, mapping.sourceIsFolder,
      deletedDestinationIds.has(mapping.destinationId) ? "deleted" : "skipped",
      deletedDestinationIds.has(mapping.destinationId)
        ? "Deleted with its managed parent folder because the source folder no longer exists."
        : "Source and SharePoint copy were already absent; the obsolete sync mapping was removed.");
  }
  if (deletedDestinationIds.size) {
    await db.delete(syncSharepointItemsTable).where(and(
      eq(syncSharepointItemsTable.driveId, driveId),
      inArray(syncSharepointItemsTable.itemId, [...deletedDestinationIds]),
    ));
  }
  destinationByPath.clear();
  for (const [path, item] of rebuildDestinationPathIndex(destinationById)) destinationByPath.set(path, item);

  if (staleMappings.length) {
    await db.delete(syncItemsTable).where(inArray(syncItemsTable.id, staleMappings.map(mapping => mapping.id)));
  }

  const refreshedMappings = await db.select().from(syncItemsTable).where(and(
    eq(syncItemsTable.destinationRootId, config.destinationFolderId),
    inArray(syncItemsTable.sourceRootId, sourceRootIds),
  ));
  for (const mapping of refreshedMappings) mappedDestinationIds.add(mapping.destinationId);

  const knownDestinationIds = new Set([
    destinationRoot.id,
    ...mappedDestinationIds,
    ...detachedDestinationIds,
    ...conflictDestinationIds,
    ...deletedDestinationIds,
    ...excludedDestinationIds,
  ]);
  for (const item of destinationById.values()) {
    if (knownDestinationIds.has(item.id)) continue;
    let parentId = item.parentId;
    let coveredByUnknownFolder = false;
    while (parentId && parentId !== destinationRoot.id) {
      if (!knownDestinationIds.has(parentId)) {
        coveredByUnknownFolder = true;
        break;
      }
      parentId = destinationById.get(parentId)?.parentId;
    }
    if (coveredByUnknownFolder) continue;
    await recordConflict(item.path, item.isFolder, "untracked-sharepoint-item");
  }

  summary.conflicts = conflictKeys.size;
  return { summary, conflicts };
}

export async function runScheduledSync(): Promise<SyncResult> {
  const { db, pool } = await import("@workspace/db");
  const lockConnection = await pool.connect();
  let locked = false;
  let client: ShufflrrClient | undefined;
  const runId = randomUUID();
  let phase: SyncPhase = "configuration";
  let intervalSeconds = 60;
  let journal: SyncRunJournal | undefined;
  let pendingRetries: Array<typeof syncFileFailuresTable.$inferSelect> = [];
  try {
    const lock = await lockConnection.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SYNC_LOCK_ID],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { skipped: true };

    const [config] = await db.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1);
    const queued = await db.select().from(syncFileFailuresTable).where(and(
      isNull(syncFileFailuresTable.resolvedAt), isNotNull(syncFileFailuresTable.retryRequestedAt),
    )).orderBy(syncFileFailuresTable.id).limit(1);
    for (const row of queued) {
      const valid = config?.destinationFolderId === row.destinationRootId &&
        config.sourceFolders.some(folder => folder.id === row.sourceRootId) &&
        !config.excludedFolders.some(folder => folder.rootId === row.sourceRootId && row.ancestorIds.includes(folder.id));
      if (valid) pendingRetries.push(row);
      else await db.update(syncFileFailuresTable).set({ retryRequestedAt: null,
        reason: "The sync scope changed. This file was not retried; adjust the selection or dismiss this notice." })
        .where(eq(syncFileFailuresTable.id, row.id));
    }
    if (!config || (!config.enabled && !pendingRetries.length)) return { skipped: true, nextCheckMs: 5000 };
    if (config.providerRetryAt && config.providerRetryAt > new Date()) {
      pendingRetries = []; // Keep queued rows intact during a provider cooldown.
      return { skipped: true, nextCheckMs: 1000 };
    }
    intervalSeconds = config.pollIntervalSeconds;
    if (!pendingRetries.length && config.nextRunAt && config.nextRunAt.getTime() > Date.now()) {
      return { skipped: true, nextCheckMs: Math.min(5000, config.nextRunAt.getTime() - Date.now()) };
    }
    if (!config.destinationFolderId || !config.destinationFolderName || !config.sourceFolders.length) {
      throw new Error("The shared sync configuration is incomplete.");
    }

    journal = new SyncRunJournal(db, runId);
    journal.fileFailures = new SyncFileFailureStore(db, config.destinationFolderId,
      new URL(shufflrrConfig().baseUrl).origin);
    await journal.start();
    await db.update(syncConfigTable).set({
      lastRunAt: new Date(),
      lastRunStatus: "running",
      lastRunError: null,
      lastRunSummary: null,
      lastRunConflicts: [],
    }).where(eq(syncConfigTable.id, 1));

    client = newShufflrrClient();
    const credentials = shufflrrConfig();
    phase = "authentication";
    await client.login(credentials.email, credentials.password);
    const outcome = await performSync(db, client, {
      destinationFolderId: config.destinationFolderId,
      destinationFolderName: config.destinationFolderName,
      sourceFolders: config.sourceFolders,
      excludedFolders: config.excludedFolders,
      ...(pendingRetries.length ? { retryTargets: pendingRetries.map(row =>
        ({ sourceRootId: row.sourceRootId, sourceId: row.sourceId })) } : {}),
    }, nextPhase => { phase = nextPhase; }, undefined, journal);
    const status = outcome.conflicts.length ? "partial" : "success";
    phase = "save_status";
    await saveRunState(db, {
      status,
      summary: outcome.summary,
      conflicts: outcome.conflicts,
      error: null,
    });
    await journal.finish(status, null);
    return { skipped: false, status, summary: outcome.summary, nextCheckMs: Math.min(5000, intervalSeconds * 1000) };
  } catch (error) {
    const message = safeError(error);
    if (pendingRetries.length) await db.update(syncFileFailuresTable).set({
      reason: message,
      dismissedAt: sql`case when ${syncFileFailuresTable.reason} = ${message}
        then ${syncFileFailuresTable.dismissedAt} else null end`,
    }).where(and(inArray(syncFileFailuresTable.id, pendingRetries.map(row => row.id)),
      isNull(syncFileFailuresTable.resolvedAt))).catch(() => {});
    const cause = error instanceof Error ? error.cause : undefined;
    logger.error({
      event: "sync_run_failed",
      requestId: runId,
      phase,
      code: diagnosticCode(error),
      causeCode: diagnosticCode(cause),
      status: error instanceof AccessError ? error.status : undefined,
      provider: error instanceof ProviderBackoffError ? error.provider : undefined,
      retryAt: retryDate(error),
      reason: message,
    }, "Sync run failed.");
    if (journal) {
      if (!journal.hasFailure) await journal.record({
        status: "failed", path: null, destinationPath: null, itemType: "run",
        message: `${message} Reference: ${runId}`,
      }).catch(() => {});
      await journal.finish("failed", `${message} Reference: ${runId}`).catch(() => {});
    }
    await saveRunState(db, {
      status: "failed",
      summary: journal?.summary ?? null,
      conflicts: journal?.conflicts ?? [],
      error: `${message} Reference: ${runId}`,
      retryAt: retryDate(error),
    }).catch(() => {});
    throw error;
  } finally {
    if (pendingRetries.length) await db.update(syncFileFailuresTable).set({ retryRequestedAt: null })
      .where(inArray(syncFileFailuresTable.id, pendingRetries.map(row => row.id))).catch(() => {});
    await client?.close().catch(() => {});
    if (locked) {
      await lockConnection.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK_ID]).catch(() => {});
    }
    lockConnection.release();
  }
}
