import { and, eq, sql } from "drizzle-orm";
import { syncSharepointItemsTable, syncSharepointStateTable } from "@workspace/db/schema";
import { AccessError, getSyncDeltaPage, getSyncDriveItem, syncDriveId, type SyncDriveItem } from "./sharepoint";

const MAX_ITEMS = 100_000;

/** Apply IDs, not paths: a folder rename/move changes the paths of all its descendants. */
export function applyDelta(
  items: Map<string, SyncDriveItem>,
  changes: Array<{ id: string; deleted: boolean; item?: SyncDriveItem }>,
): Map<string, SyncDriveItem> {
  const next = new Map(items);
  const removed = new Set<string>();
  for (const change of changes) {
    if (change.deleted) {
      next.delete(change.id);
      removed.add(change.id);
    } else if (change.item) {
      next.set(change.id, change.item);
      removed.delete(change.id);
    }
  }
  // Prune children of deleted folders, except children explicitly moved elsewhere by the same batch.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of next.values()) {
      if (item.parentId && removed.has(item.parentId)) {
        next.delete(item.id);
        removed.add(item.id);
        changed = true;
      }
    }
  }
  if (next.size > MAX_ITEMS) throw new AccessError("SyncLimit", "SharePoint change tracking exceeded its item safety limit.", 413);
  return next;
}

export function scopeSnapshot(items: Map<string, SyncDriveItem>, rootId: string) {
  const root = items.get(rootId);
  if (!root?.isFolder) throw new AccessError("InvalidDestination", "The SharePoint sync folder is not in the completed change snapshot.", 404);
  const children = new Map<string, SyncDriveItem[]>();
  for (const item of items.values()) {
    if (!item.parentId) continue;
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item);
    children.set(item.parentId, siblings);
  }
  const records: (SyncDriveItem & { path: string })[] = [];
  const queue = [{ id: root.id, path: "", depth: 0 }];
  const visited = new Set([root.id]);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.depth > 100) throw new AccessError("SyncLimit", "SharePoint nesting exceeded its safety limit.", 413);
    for (const item of children.get(current.id) ?? []) {
      if (visited.has(item.id)) throw new AccessError("GraphSchema", "A SharePoint hierarchy cycle was detected.");
      visited.add(item.id);
      const path = current.path ? `${current.path}/${item.name}` : item.name;
      records.push({ ...item, path });
      if (item.isFolder) queue.push({ id: item.id, path, depth: current.depth + 1 });
    }
  }
  return { root, records };
}

export async function loadDestinationSnapshot(
  db: typeof import("@workspace/db")["db"],
  rootId: string,
) {
  const driveId = await syncDriveId();
  const root = await getSyncDriveItem(rootId);
  const [state] = await db.select().from(syncSharepointStateTable)
    .where(eq(syncSharepointStateTable.driveId, driveId)).limit(1);
  const rows = state ? await db.select().from(syncSharepointItemsTable)
    .where(eq(syncSharepointItemsTable.driveId, driveId)) : [];
  let items = new Map(rows.map(row => [row.itemId, row.item]));
  let cursor: string | undefined = state?.deltaLink;
  let rebased = !state;
  const changes = new Map<string, { id: string; deleted: boolean; item?: SyncDriveItem }>();
  let deltaLink: string | undefined;
  for (let pages = 0; ; pages++) {
    if (pages > 1000) throw new AccessError("SyncLimit", "SharePoint delta pagination exceeded its safety limit.", 413);
    let page;
    try {
      page = await getSyncDeltaPage(driveId, cursor);
    } catch (error) {
      // Expired delta tokens require a complete new baseline, never an empty "successful" snapshot.
      if (!rebased && error instanceof AccessError && error.status === 410) {
        rebased = true;
        cursor = undefined;
        items = new Map();
        changes.clear();
        continue;
      }
      throw error;
    }
    for (const change of page.changes) changes.set(change.id, change);
    if (changes.size > MAX_ITEMS) throw new AccessError("SyncLimit", "SharePoint delta exceeded its safety limit.", 413);
    if (page.nextLink) {
      cursor = page.nextLink;
      continue;
    }
    if (!page.deltaLink) throw new AccessError("GraphSchema", "SharePoint returned no completed change cursor.");
    deltaLink = page.deltaLink;
    break;
  }
  const next = applyDelta(items, [...changes.values()]);
  if (rootId === "root" && !next.has(root.id)) next.set(root.id, root);
  const scope = scopeSnapshot(next, root.id);
  // Commit only a fully fetched feed. Never advance the cursor after our own writes:
  // the following run must see those writes and any concurrent SharePoint edits.
  await db.transaction(async tx => {
    if (rebased) await tx.delete(syncSharepointItemsTable).where(eq(syncSharepointItemsTable.driveId, driveId));
    else {
      for (const id of items.keys()) {
        if (!next.has(id)) await tx.delete(syncSharepointItemsTable).where(
          and(eq(syncSharepointItemsTable.driveId, driveId), eq(syncSharepointItemsTable.itemId, id)),
        );
      }
    }
    const updated = rebased ? [...next.values()] : [...changes.values()]
      .flatMap(change => next.has(change.id) ? [next.get(change.id)!] : []);
    for (let start = 0; start < updated.length; start += 500) {
      await tx.insert(syncSharepointItemsTable).values(updated.slice(start, start + 500).map(item => ({
        driveId, itemId: item.id, item,
      }))).onConflictDoUpdate({
        target: [syncSharepointItemsTable.driveId, syncSharepointItemsTable.itemId],
        set: { item: sql`excluded.item` },
      });
    }
    await tx.insert(syncSharepointStateTable).values({ driveId, deltaLink: deltaLink! })
      .onConflictDoUpdate({ target: syncSharepointStateTable.driveId, set: { deltaLink: deltaLink! } });
  });
  return { ...scope, driveId };
}
