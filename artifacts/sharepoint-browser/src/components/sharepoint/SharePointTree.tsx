import { useState } from "react";
import { Library } from "lucide-react";
import { TreeItem, TreeRoot } from "@/components/tree/TreeView";
import { BranchError, BranchLoadMore, BranchLoading, BranchNote } from "@/components/tree/BranchStatus";
import { MAX_TREE_DEPTH, useExpandedSet, withAncestor } from "@/components/tree/tree-utils";
import { useSharePointBranch } from "./use-sharepoint-branch";
import { SharePointItemActions, type SelectedSharePointItem } from "./SharePointItemActions";
import type { LibraryItem } from "@workspace/api-client-react";
import { FileMetadataButton } from "@/components/metadata/FileMetadataButton";

type BranchProps = {
  folderId?: string; level: number; ancestors: ReadonlySet<string>; active: boolean;
  expanded: Set<string>; toggle: (key: string) => void; onAccessTest: () => void;
  selected: Map<string, SelectedSharePointItem>;
  onSelect: (item: LibraryItem, ancestors: string[], selected: boolean) => void;
};

const NO_ANCESTORS: ReadonlySet<string> = new Set();

function SharePointBranch({ folderId, level, ancestors, active, expanded, toggle, onAccessTest, selected, onSelect }: BranchProps) {
  const { query: q, items } = useSharePointBranch(folderId, active);
  const sfx = folderId ? `-${folderId}` : "";

  if (q.isPending && !q.isError) return <BranchLoading level={level} testId={`loading-list${sfx}`} />;
  const error = q.isError ? (
    <BranchError
      level={level}
      title={q.isFetchNextPageError ? "Could not load more items" : "Could not read this folder"}
      error={q.error}
      onRetry={() => void (q.isFetchNextPageError ? q.fetchNextPage() : q.refetch())}
      onAccessTest={onAccessTest}
      testId={`error-list${sfx}`}
      retryTestId={`button-retry-list${sfx}`}
      accessTestId={`button-go-access-test${sfx}`}
    />
  ) : null;
  if (!items.length) return error ?? <BranchNote level={level} text="This folder is empty." testId={`empty-list${sfx}`} />;

  return (
    <>
      {items.map((it) => {
        const open = it.isFolder && expanded.has(it.id);
        return (
          <TreeItem
            key={it.id}
            treeKey={it.id}
            level={level}
            name={it.name}
            isFolder={it.isFolder}
            expanded={open}
            onToggle={toggle}
            size={it.size}
            modifiedAt={it.modifiedAt}
            actions={!it.isFolder && <FileMetadataButton name={it.name} identity={{ itemId: it.id }} />}
            fileLink={it.isFolder ? undefined : { href: it.webUrl, external: true }}
            testId={it.isFolder ? `folder-${it.id}` : `file-${it.id}`}
            selected={selected.has(it.id)}
            selectionDisabled={!selected.has(it.id) && selected.size >= 100}
            onSelect={(checked) => onSelect(it, [...ancestors], checked)}
          >
            {open && (ancestors.has(it.id)
              ? <BranchNote level={level + 1} text="This folder repeats one of its parents, so it is not expanded again." testId={`note-cycle-${it.id}`} />
              : level >= MAX_TREE_DEPTH
                ? <BranchNote level={level + 1} text={`Nesting deeper than ${MAX_TREE_DEPTH} levels is not shown here. Open the library in SharePoint to continue.`} testId={`note-depth-${it.id}`} />
                : <SharePointBranch folderId={it.id} level={level + 1} ancestors={withAncestor(ancestors, it.id)} active={active} expanded={expanded} toggle={toggle} onAccessTest={onAccessTest} selected={selected} onSelect={onSelect} />)}
          </TreeItem>
        );
      })}
      {error}
      {!q.isError && q.hasNextPage && (
        <BranchLoadMore level={level} shown={items.length} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} testId={`button-load-more${sfx}`} />
      )}
    </>
  );
}

export function SharePointTree({ libraryName, active, onAccessTest }: { libraryName: string; active: boolean; onAccessTest: () => void }) {
  const { expanded, toggle } = useExpandedSet();
  const [selected, setSelected] = useState<Map<string, SelectedSharePointItem>>(() => new Map());

  const updateSelection = (item: LibraryItem, ancestorIds: string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(item.id, { item, ancestorIds });
      else next.delete(item.id);
      return next;
    });
  };

  const removeSelection = (ids: string[]) => {
    setSelected((current) => {
      const next = new Map(current);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  };

  return (
    <section className="rise min-w-0 rounded-lg border bg-card" data-testid="browser">
      <div className="flex min-w-0 items-center gap-2 border-b px-4 py-3 text-sm">
        <Library className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate font-medium" title={libraryName}>{libraryName}</span>
      </div>
      <SharePointItemActions selectedItems={[...selected.values()]} onComplete={removeSelection} />
      <TreeRoot label={`${libraryName} folders and files`} onToggle={toggle} testId="tree-sharepoint">
        <SharePointBranch
          level={1}
          ancestors={NO_ANCESTORS}
          active={active}
          expanded={expanded}
          toggle={toggle}
          onAccessTest={onAccessTest}
          selected={selected}
          onSelect={updateSelection}
        />
      </TreeRoot>
    </section>
  );
}
