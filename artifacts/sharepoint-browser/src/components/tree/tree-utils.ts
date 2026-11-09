import { useCallback, useState } from "react";

export const TREE_STALE_MS = 60_000;
/** Deepest level rendered inline. Protects against malformed, very deep provider data. */
export const MAX_TREE_DEPTH = 20;

type Sortable = { name: string; isFolder: boolean };

export function sortTreeItems<T extends Sortable>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.isFolder === b.isFolder
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      : a.isFolder ? -1 : 1,
  );
}

/** Folders-first within each page, pages appended in order, duplicate ids dropped. */
export function mergePages<T extends Sortable & { id: string | number }>(pages: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) {
    for (const it of sortTreeItems(page)) {
      const k = String(it.id);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

/** Expanded folder keys survive collapsing ancestors and panel switches (panels stay mounted). */
export function useExpandedSet() {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  return { expanded, toggle };
}

export function withAncestor(ancestors: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(ancestors);
  next.add(key);
  return next;
}
