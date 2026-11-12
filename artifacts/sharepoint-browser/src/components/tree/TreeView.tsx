import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, Download, ExternalLink, FileText, Folder, FolderOpen } from "lucide-react";
import { fmtDate, fmtSize } from "@/components/shufflrr/format";
import { ensureRovingTabStop, handleTreeKeyDown, syncTabStopOnFocus } from "./tree-keyboard";

export function indentStyle(level: number) {
  return { paddingLeft: `calc(${Math.min(level - 1, 12)} * var(--tree-indent) + 0.75rem)` };
}

export function TreeRoot({ label, onToggle, children, testId }: { label: string; onToggle: (key: string) => void; children: ReactNode; testId: string }) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Queries resolve inside child branches without rerendering TreeRoot.
    const refresh = () => ensureRovingTabStop(root);
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <ul
      ref={ref}
      role="tree"
      aria-label={label}
      className="tree-root min-w-0 overflow-hidden py-1"
      onKeyDown={(e) => handleTreeKeyDown(e, onToggle)}
      onFocus={syncTabStopOnFocus}
      data-testid={testId}
    >
      {children}
    </ul>
  );
}

type FileLink = { href: string; download?: string; external?: boolean };

export function TreeItem({
  treeKey, level, name, isFolder, expanded, onToggle, size, modifiedAt, fileLink, testId, children,
  selected, onSelect, selectionDisabled, archived,
}: {
  treeKey: string; level: number; name: string; isFolder: boolean; expanded: boolean;
  onToggle: (key: string) => void; size?: number; modifiedAt: string; fileLink?: FileLink; testId: string; children?: ReactNode;
  selected?: boolean; onSelect?: (selected: boolean) => void; selectionDisabled?: boolean; archived?: boolean;
}) {
  const kind = isFolder ? "folder" : "file";
  return (
    <li
      role="treeitem"
      tabIndex={-1}
      aria-level={level}
      aria-expanded={isFolder ? expanded : undefined}
      aria-label={`${name}, ${kind}${isFolder ? (expanded ? ", expanded" : ", collapsed") : ""}`}
      data-tree-key={isFolder ? treeKey : undefined}
      className="outline-none"
      data-testid={testId}
    >
      <div
        className={`tree-row group flex min-w-0 items-center gap-2 py-1.5 pr-3 text-sm hover:bg-secondary/60 ${archived ? "text-muted-foreground bg-muted/40" : ""} ${isFolder || fileLink ? "cursor-pointer" : ""}`}
        style={indentStyle(level)}
        onClick={(event) => {
          event.currentTarget.parentElement?.focus();
          if ((event.target as Element).closest("[data-tree-action]")) return;
          if (isFolder) onToggle(treeKey);
          else if (fileLink)
            event.currentTarget.querySelector<HTMLAnchorElement>("[data-tree-action]")?.click();
        }}
        title={name}
      >
        {onSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            disabled={selectionDisabled}
            aria-label={`Select ${name} ${kind}`}
            data-tree-action
            data-testid={`select-${testId}`}
            className="size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
            onChange={(event) => onSelect(event.currentTarget.checked)}
            onClick={(event) => event.stopPropagation()}
          />
        )}
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
          {isFolder && <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />}
        </span>
        {isFolder
          ? expanded
            ? <FolderOpen className="size-4 shrink-0 fill-primary/15 text-primary" aria-hidden="true" />
            : <Folder className="size-4 shrink-0 fill-primary/15 text-primary" aria-hidden="true" />
          : <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        {fileLink ? (
          <a
            href={fileLink.href}
            {...(fileLink.external ? { target: "_blank", rel: "noopener noreferrer" } : { download: fileLink.download })}
            tabIndex={-1}
            data-tree-action
            title={fileLink.external ? `Open ${name}` : `Download ${name}`}
            className="min-w-0 flex-1 truncate hover:text-primary hover:underline"
            data-testid={`${testId}-link`}
          >
            {name}
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate">{name}</span>
        )}
        {archived && <span className="shrink-0 rounded border px-1.5 text-[11px]" aria-label="Archived in Shufflrr">Archived</span>}
        <span className="hidden w-20 shrink-0 text-right font-mono text-xs text-muted-foreground sm:block">{isFolder || size === undefined ? "" : fmtSize(size)}</span>
        <span className="hidden w-40 shrink-0 text-right font-mono text-xs text-muted-foreground md:block">{fmtDate(modifiedAt)}</span>
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
          {fileLink && (fileLink.external ? <ExternalLink className="size-3.5 opacity-60 group-hover:opacity-100" /> : <Download className="size-3.5" />)}
        </span>
      </div>
      {isFolder && expanded && <ul role="group" className="min-w-0">{children}</ul>}
    </li>
  );
}
