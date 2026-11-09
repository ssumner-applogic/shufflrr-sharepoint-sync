import { TreeItem, TreeRoot } from "@/components/tree/TreeView";
import { BranchError, BranchLoading, BranchNote } from "@/components/tree/BranchStatus";
import { MAX_TREE_DEPTH, useExpandedSet, withAncestor } from "@/components/tree/tree-utils";
import { downloadHref } from "./format";
import { useShufflrrBranch } from "./use-shufflrr-branch";

type BranchProps = {
  folderId?: number; level: number; ancestors: ReadonlySet<string>; active: boolean;
  expanded: Set<string>; toggle: (key: string) => void; onAccessTest: () => void;
};

const NO_ANCESTORS: ReadonlySet<string> = new Set();

function ShufflrrBranch({ folderId, level, ancestors, active, expanded, toggle, onAccessTest }: BranchProps) {
  const { query: q, items } = useShufflrrBranch(folderId, active);
  const sfx = folderId ? `-${folderId}` : "";

  if (q.isError) {
    return (
      <BranchError
        level={level}
        title="Could not read this Shufflrr folder"
        error={q.error}
        onRetry={() => void q.refetch()}
        onAccessTest={onAccessTest}
        testId={`error-shufflrr-list${sfx}`}
        retryTestId={`button-shufflrr-retry${sfx}`}
        accessTestId={`button-shufflrr-go-access-test${sfx}`}
      />
    );
  }
  if (!q.data) return <BranchLoading level={level} testId={`loading-shufflrr-list${sfx}`} />;
  if (!items.length) {
    return <BranchNote level={level} text={folderId ? "This folder is empty." : "No accessible Shufflrr roots for this account."} testId={`empty-shufflrr-list${sfx}`} />;
  }

  return (
    <>
      {items.map((it) => {
        const key = String(it.id);
        const open = it.isFolder && expanded.has(key);
        return (
          <TreeItem
            key={key}
            treeKey={key}
            level={level}
            name={it.name}
            isFolder={it.isFolder}
            expanded={open}
            onToggle={toggle}
            size={it.size}
            modifiedAt={it.modifiedAt}
            fileLink={it.isFolder ? undefined : { href: downloadHref(it.id), download: it.name }}
            testId={it.isFolder ? `shufflrr-folder-${it.id}` : `shufflrr-file-${it.id}`}
          >
            {open && (ancestors.has(key)
              ? <BranchNote level={level + 1} text="This folder repeats one of its parents, so it is not expanded again." testId={`note-shufflrr-cycle-${it.id}`} />
              : level >= MAX_TREE_DEPTH
                ? <BranchNote level={level + 1} text={`Nesting deeper than ${MAX_TREE_DEPTH} levels is not shown here. Open the Shufflrr portal to continue.`} testId={`note-shufflrr-depth-${it.id}`} />
                : <ShufflrrBranch folderId={it.id} level={level + 1} ancestors={withAncestor(ancestors, key)} active={active} expanded={expanded} toggle={toggle} onAccessTest={onAccessTest} />)}
          </TreeItem>
        );
      })}
    </>
  );
}

export function ShufflrrTree({ active, onAccessTest }: { active: boolean; onAccessTest: () => void }) {
  const { expanded, toggle } = useExpandedSet();
  return (
    <TreeRoot label="Shufflrr folders and files" onToggle={toggle} testId="tree-shufflrr">
      <ShufflrrBranch level={1} ancestors={NO_ANCESTORS} active={active} expanded={expanded} toggle={toggle} onAccessTest={onAccessTest} />
    </TreeRoot>
  );
}
