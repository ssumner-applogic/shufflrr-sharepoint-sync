import type { SyncFolderExclusion, SyncItem, SyncSourceFolder } from "@workspace/db/schema";
import type { Entry, ShufflrrClient } from "@workspace/shufflrr";
import { AccessError } from "./sharepoint";

/** Verify ancestry against the provider rather than trusting browser-supplied tree metadata. */
export async function validateFolderExclusions(
  client: ShufflrrClient,
  roots: SyncSourceFolder[],
  exclusions: SyncFolderExclusion[],
  trustedExisting: SyncFolderExclusion[] = [],
): Promise<SyncFolderExclusion[]> {
  const rootIds = new Set(roots.map(root => root.id));
  const seen = new Set<number>();
  const listings = new Map<number, Entry[]>();
  let inspectedEntries = 0;
  const validated: SyncFolderExclusion[] = [];
  for (const exclusion of exclusions) {
    const chain = exclusion.ancestorIds;
    if (!rootIds.has(exclusion.rootId) || rootIds.has(exclusion.id) || seen.has(exclusion.id) ||
      chain[0] !== exclusion.rootId || chain.includes(exclusion.id) ||
      new Set(chain).size !== chain.length ||
      chain.some((id, index) => index > 0 && rootIds.has(id))) {
      throw new AccessError("InvalidExclusion", "Choose exclusions beneath one selected source folder.", 400);
    }
    seen.add(exclusion.id);
    const trusted = trustedExisting.find(folder => folder.id === exclusion.id && folder.rootId === exclusion.rootId &&
      JSON.stringify(folder.ancestorIds) === JSON.stringify(exclusion.ancestorIds));
    if (trusted) {
      // Previously excluded copies must stay excluded even if their source folder was deleted.
      validated.push({ ...trusted });
      continue;
    }
    let resolved: Entry | undefined;
    const path = [...chain, exclusion.id];
    for (let index = 0; index < path.length - 1; index++) {
      const parent = path[index];
      let children = listings.get(parent);
      if (!children) {
        children = await client.contents(parent);
        inspectedEntries += children.length;
        if (listings.size >= 5000 || inspectedEntries > 100_000) {
          throw new AccessError("ExclusionLimit", "Too many folder entries to verify these exclusions in one request.", 400);
        }
        listings.set(parent, children);
      }
      resolved = children.find(child => child.isFolder && child.id === path[index + 1]);
      if (!resolved) throw new AccessError("InvalidExclusion", "An excluded folder moved or is unavailable. Refresh and select it again.", 400);
    }
    validated.push({ ...exclusion, name: resolved!.name });
  }
  // A parent exclusion covers its descendants; keep only the highest exclusion.
  return validated.filter(exclusion => !validated.some(other =>
    other.rootId === exclusion.rootId && exclusion.ancestorIds.includes(other.id)));
}

/** IDs, not names/paths: copies remain protected even after a folder has moved or disappeared. */
export function excludedMappingIds(mappings: SyncItem[], exclusions: SyncFolderExclusion[]): Set<number> {
  const excluded = new Set(exclusions.map(folder => `${folder.rootId}:${folder.id}`));
  const folderByKey = new Map(mappings.filter(item => item.sourceIsFolder)
    .map(item => [`${item.sourceRootId}:${item.sourceId}`, item]));
  const protectedIds = new Set<number>();
  for (const mapping of mappings) {
    let folderId = mapping.sourceIsFolder ? mapping.sourceId : mapping.sourceParentId;
    const visited = new Set<string>();
    while (folderId) {
      const key = `${mapping.sourceRootId}:${folderId}`;
      if (excluded.has(key)) { protectedIds.add(mapping.id); break; }
      if (visited.has(key) || visited.size > 100) throw new Error("The saved sync folder ancestry is invalid.");
      visited.add(key);
      folderId = folderByKey.get(key)?.sourceParentId ?? null;
    }
  }
  return protectedIds;
}

export const exclusionNoticeKey = (folder: SyncFolderExclusion) => `${folder.rootId}:excluded:${folder.id}`;
