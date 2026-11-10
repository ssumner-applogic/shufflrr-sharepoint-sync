import type { SyncFolderExclusion, SyncSourceFolder } from "@workspace/api-client-react";

function beneath(id: number, ancestorId: number, parents: Map<number, number>) {
  const seen = new Set<number>();
  let parent = parents.get(id);
  while (parent !== undefined && !seen.has(parent)) {
    if (parent === ancestorId) return true;
    seen.add(parent);
    parent = parents.get(parent);
  }
  return false;
}

export function folderSelectionState(
  id: number, ancestors: number[], roots: Map<number, SyncSourceFolder>,
  exclusions: Map<number, SyncFolderExclusion>, parents: Map<number, number>,
) {
  const rootId = roots.has(id) ? id : ancestors.find(parent => roots.has(parent));
  const excludedByAncestor = rootId !== undefined && ancestors.some(parent =>
    exclusions.get(parent)?.rootId === rootId);
  const explicitlyExcluded = exclusions.get(id)?.rootId === rootId && rootId !== undefined;
  const checked = rootId !== undefined && !excludedByAncestor && !explicitlyExcluded;
  const excludedDescendant = [...exclusions.values()].some(folder =>
    folder.rootId === rootId && currentExclusionAncestors(folder, parents).includes(id));
  const selectedDescendant = [...roots.keys()].some(root => beneath(root, id, parents));
  return {
    checked, rootId, explicitlyExcluded, excludedByAncestor,
    inherited: checked && !roots.has(id),
    indeterminate: checked ? excludedDescendant : !excludedByAncestor && !explicitlyExcluded && selectedDescendant,
  };
}

/** Prefer freshly loaded tree ancestry, falling back to saved paths for unopened branches. */
export function currentExclusionAncestors(folder: SyncFolderExclusion, parents: Map<number, number>): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let parent = parents.get(folder.id);
  while (parent !== undefined && !seen.has(parent)) {
    chain.push(parent);
    if (parent === folder.rootId) return chain.reverse();
    seen.add(parent);
    parent = parents.get(parent);
  }
  return folder.ancestorIds;
}

export function toggleFolderSelection(
  folder: SyncSourceFolder, ancestors: number[], checked: boolean,
  roots: Map<number, SyncSourceFolder>, exclusions: Map<number, SyncFolderExclusion>,
  parents: Map<number, number>,
) {
  const nextRoots = new Map(roots);
  const nextExcluded = new Map(exclusions);
  const state = folderSelectionState(folder.id, ancestors, roots, exclusions, parents);
  if (state.excludedByAncestor) return { roots: nextRoots, exclusions: nextExcluded };
  if (!checked && roots.has(folder.id)) {
    nextRoots.delete(folder.id);
    for (const [id, exclusion] of nextExcluded) {
      if (exclusion.rootId === folder.id) nextExcluded.delete(id);
    }
  } else if (state.rootId !== undefined && !roots.has(folder.id)) {
    for (const [id, exclusion] of nextExcluded) {
      if (id === folder.id || exclusion.ancestorIds.includes(folder.id)) nextExcluded.delete(id);
    }
    if (!checked) nextExcluded.set(folder.id, {
      ...folder, rootId: state.rootId, ancestorIds: ancestors.slice(ancestors.indexOf(state.rootId)),
    });
  } else if (checked) {
    // Selecting a broader folder replaces explicitly selected descendants, avoiding overlapping roots.
    for (const root of nextRoots.keys()) {
      if (beneath(root, folder.id, parents)) {
        nextRoots.delete(root);
        for (const [id, exclusion] of nextExcluded) {
          if (exclusion.rootId === root) nextExcluded.delete(id);
        }
      }
    }
    nextRoots.set(folder.id, folder);
  }
  return { roots: nextRoots, exclusions: nextExcluded };
}
