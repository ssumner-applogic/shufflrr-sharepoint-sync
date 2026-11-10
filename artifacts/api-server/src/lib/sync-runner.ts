import { and, eq, inArray, notInArray } from "drizzle-orm";
import {
  syncConfigTable,
  syncItemsTable,
  type SyncConflict,
  type SyncRunSummary,
  type SyncSourceFolder,
} from "@workspace/db/schema";
import { ShufflrrClient, ShufflrrError, type Entry } from "@workspace/shufflrr";
import { newShufflrrClient, shufflrrConfig } from "./shufflrr";
import {
  AccessError,
  createSyncFolder,
  deleteSyncItem,
  getSyncDriveItem,
  listSyncFolder,
  updateSyncItem,
  uploadSyncFile,
  type SyncDriveItem,
} from "./sharepoint";

export const SYNC_LOCK_ID = 74120937;
const MAX_SOURCE_FOLDERS = 5_000;
const MAX_TOTAL_ITEMS = 100_000;
const MAX_DEPTH = 100;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
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
  if (error instanceof ShufflrrError) {
    if (error.code === "configuration") return "Shufflrr is not configured on the server.";
    if (error.code === "authentication") return "Shufflrr authentication failed.";
    if (error.code === "permission") return "The Shufflrr service account cannot read a selected folder.";
    if (error.code === "limit") return "A selected Shufflrr folder exceeded a sync safety limit.";
  }
  if (error instanceof AccessError) {
    if (error.status === 401 || error.status === 403) return "SharePoint denied a sync operation. Check write access to the selected folder.";
    if (error.status === 404) return "The SharePoint destination or a managed item could not be found.";
    if (error.status === 409 || error.code === "SyncConflict") return "A SharePoint item changed during sync and was left unchanged.";
  }
  return "The sync run could not complete. Check the provider connections and permissions.";
}

async function loadSourceTree(client: ShufflrrClient, roots: SyncSourceFolder[]): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
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

  return records;
}

async function loadDestinationTree(rootId: string): Promise<{
  root: SyncDriveItem;
  records: DestinationRecord[];
}> {
  const root = await getSyncDriveItem(rootId);
  if (!root.isFolder) throw new AccessError("InvalidDestination", "The configured SharePoint destination is not a folder.", 400);

  const records: DestinationRecord[] = [];
  const queue: Array<{ folder: SyncDriveItem; path: string; depth: number }> = [{
    folder: root,
    path: "",
    depth: 0,
  }];
  const visited = new Set<string>([root.id]);
  let folderCount = 0;

  while (queue.length) {
    const current = queue.shift()!;
    const children = await listSyncFolder(current.folder.id);
    for (const item of children) {
      if (records.length >= MAX_TOTAL_ITEMS) throw new Error("The SharePoint destination exceeded a sync safety limit.");
      const path = current.path ? `${current.path}/${item.name}` : item.name;
      const record: DestinationRecord = { ...item, path };
      records.push(record);
      if (!item.isFolder) continue;
      if (++folderCount > MAX_SOURCE_FOLDERS || current.depth >= MAX_DEPTH) {
        throw new Error("The SharePoint destination exceeded a sync safety limit.");
      }
      if (visited.has(item.id)) throw new Error("A SharePoint folder cycle was detected.");
      visited.add(item.id);
      queue.push({ folder: item, path, depth: current.depth + 1 });
    }
  }
  return { root, records };
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
  },
): Promise<void> {
  await db.update(syncConfigTable).set({
    lastRunAt: new Date(),
    lastRunStatus: values.status,
    lastRunSummary: values.summary,
    lastRunConflicts: values.conflicts,
    lastRunError: values.error,
  }).where(eq(syncConfigTable.id, 1));
}

async function performSync(
  db: typeof import("@workspace/db")["db"],
  client: ShufflrrClient,
  config: {
    destinationFolderId: string;
    destinationFolderName: string;
    sourceFolders: SyncSourceFolder[];
  },
): Promise<{ summary: SyncRunSummary; conflicts: SyncConflict[] }> {
  const sourceRecords = await loadSourceTree(client, config.sourceFolders);
  const sourceRootIds = config.sourceFolders.map(folder => String(folder.id));
  const { root: destinationRoot, records: initialDestinations } = await loadDestinationTree(config.destinationFolderId);
  const destinationById = new Map(initialDestinations.map(item => [item.id, item]));
  const destinationByPath = destinationPathIndex(initialDestinations);

  const existingMappings = await db.select().from(syncItemsTable).where(and(
    eq(syncItemsTable.destinationRootId, config.destinationFolderId),
    inArray(syncItemsTable.sourceRootId, sourceRootIds),
  ));
  const allMappingsForDestination = await db.select().from(syncItemsTable).where(
    eq(syncItemsTable.destinationRootId, config.destinationFolderId),
  );
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

  for (const record of sourceRecords) {
    const rootId = String(record.root.id);
    const itemId = String(record.entry.id);
    const key = sourceKey(rootId, itemId, record.entry.isFolder);
    liveSourceKeys.add(key);
    const mapping = mappingBySource.get(key);
    if (mapping) mappedDestinationIds.add(mapping.destinationId);
    if (record.parentSourceId && blockedSourceFolders.has(`${rootId}:${record.parentSourceId}`)) continue;

    const parentDestinationId = record.parentSourceId
      ? mappingBySource.get(sourceKey(rootId, record.parentSourceId, true))?.destinationId
      : destinationRoot.id;
    if (!parentDestinationId) throw new Error("A selected destination folder could not be resolved.");

    let destinationItem = mapping ? destinationById.get(mapping.destinationId) : undefined;
    const existingAtPath = destinationByPath.get(pathKey(record.path));

    if (!mapping && existingAtPath) {
      addConflict(conflicts, conflictKeys, record.path, "path-conflict");
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
          const moved = await updateSyncItem(destinationItem.id, {
            name: record.entry.name,
            parentId: parentDestinationId,
          });
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
            addConflict(conflicts, conflictKeys, record.path, "path-conflict");
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
            ...await createSyncFolder(parentDestinationId, record.entry.name),
            path: record.path,
          };
          summary.createdFolders += 1;
        } catch (error) {
          if (error instanceof AccessError && (error.status === 409 || error.status === 412 || error.code === "SyncConflict")) {
            addConflict(conflicts, conflictKeys, record.path, "path-conflict");
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
        const advertisedSize = Number(upstream.headers.get("content-length"));
        if (Number.isFinite(advertisedSize) && advertisedSize > MAX_FILE_BYTES) {
          await upstream.body.cancel();
          throw new Error("A Shufflrr file exceeds the 100 MiB sync limit.");
        }
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("A Shufflrr file exceeds the 100 MiB sync limit.");
        try {
          destinationItem = {
            ...await uploadSyncFile(parentDestinationId, record.entry.name, bytes),
            path: record.path,
          };
          summary.copiedFiles += 1;
        } catch (error) {
          if (error instanceof AccessError && (error.status === 409 || error.status === 412 || error.code === "SyncConflict")) {
            addConflict(conflicts, conflictKeys, record.path, "path-conflict");
            continue;
          }
          throw error;
        }
      }
    } else if (!record.entry.isFolder) {
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
        const advertisedSize = Number(upstream.headers.get("content-length"));
        if (Number.isFinite(advertisedSize) && advertisedSize > MAX_FILE_BYTES) {
          await upstream.body.cancel();
          throw new Error("A Shufflrr file exceeds the 100 MiB sync limit.");
        }
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("A Shufflrr file exceeds the 100 MiB sync limit.");
        destinationItem = {
          ...await uploadSyncFile(parentDestinationId, record.entry.name, bytes, destinationItem.id),
          path: record.path,
        };
        summary.updatedFiles += 1;
      }
    }

    if (!destinationItem) throw new Error("A SharePoint item could not be created or resolved.");
    mappedDestinationIds.add(destinationItem.id);
    const previousDestination = destinationById.get(destinationItem.id);
    if (previousDestination) destinationByPath.delete(pathKey(previousDestination.path));
    destinationById.set(destinationItem.id, { ...destinationItem, path: record.path });
    destinationByPath.set(pathKey(record.path), destinationById.get(destinationItem.id)!);
    await db.insert(syncItemsTable).values({
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
    });
  }

  const staleMappings = existingMappings.filter(mapping =>
    !liveSourceKeys.has(sourceKey(mapping.sourceRootId, mapping.sourceId, mapping.sourceIsFolder)),
  );
  const staleFolderKeys = new Set(staleMappings
    .filter(mapping => mapping.sourceIsFolder)
    .map(mapping => `${mapping.sourceRootId}:${mapping.sourceId}`));
  const deletedDestinationIds = new Set<string>();

  for (const mapping of staleMappings) {
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
      await deleteSyncItem(mapping.destinationId);
      summary.deletedItems += 1;
      const destinationPath = destinationById.get(mapping.destinationId)?.path;
      for (const [id, item] of destinationById) {
        if (id === mapping.destinationId || (destinationPath && item.path.startsWith(`${destinationPath}/`))) {
          deletedDestinationIds.add(id);
          destinationById.delete(id);
        }
      }
    }
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
    addConflict(conflicts, conflictKeys, item.path, "untracked-sharepoint-item");
  }

  summary.conflicts = conflictKeys.size;
  return { summary, conflicts };
}

export async function runScheduledSync(): Promise<SyncResult> {
  const { db, pool } = await import("@workspace/db");
  const lockConnection = await pool.connect();
  let locked = false;
  let client: ShufflrrClient | undefined;
  try {
    const lock = await lockConnection.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SYNC_LOCK_ID],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { skipped: true };

    const [config] = await db.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1);
    if (!config?.enabled) return { skipped: true };
    if (!config.destinationFolderId || !config.destinationFolderName || !config.sourceFolders.length) {
      throw new Error("The shared sync configuration is incomplete.");
    }

    await db.update(syncConfigTable).set({
      lastRunAt: new Date(),
      lastRunStatus: "running",
      lastRunError: null,
    }).where(eq(syncConfigTable.id, 1));

    client = newShufflrrClient();
    const credentials = shufflrrConfig();
    await client.login(credentials.email, credentials.password);
    const outcome = await performSync(db, client, {
      destinationFolderId: config.destinationFolderId,
      destinationFolderName: config.destinationFolderName,
      sourceFolders: config.sourceFolders,
    });
    const status = outcome.conflicts.length ? "partial" : "success";
    await saveRunState(db, {
      status,
      summary: outcome.summary,
      conflicts: outcome.conflicts,
      error: null,
    });
    return { skipped: false, status, summary: outcome.summary };
  } catch (error) {
    await saveRunState(db, {
      status: "failed",
      summary: null,
      conflicts: [],
      error: safeError(error),
    }).catch(() => {});
    throw error;
  } finally {
    await client?.close().catch(() => {});
    if (locked) {
      await lockConnection.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK_ID]).catch(() => {});
    }
    lockConnection.release();
  }
}
