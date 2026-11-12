import type { SyncFileRule, SyncFolderExclusion, SyncSourceFolder } from "@workspace/db/schema";

export interface RuleScope {
  destinationFolderId: string | null;
  sourceFolders: SyncSourceFolder[];
  excludedFolders: SyncFolderExclusion[];
}
export function fileInRuleScope(file: { destinationRootId: string; sourceRootId: number; ancestorIds: number[] }, scope: RuleScope | undefined) {
  return !!scope && scope.destinationFolderId === file.destinationRootId &&
    scope.sourceFolders.some(root => root.id === file.sourceRootId) &&
    !scope.excludedFolders.some(folder => folder.rootId === file.sourceRootId && file.ancestorIds.includes(folder.id));
}
export function fileRuleKey(rootId: string | number, fileId: string | number) { return `${rootId}:${fileId}`; }
export function approvedOverwrite(rule: SyncFileRule | undefined, item: { id: string; isFolder: boolean }, ownedByOther: boolean) {
  return rule?.action === "overwrite" && !item.isFolder && !ownedByOther &&
    rule.expectedDestinationId === item.id && !!rule.expectedETag;
}
