import { ShufflrrError, type Entry } from "./client";

export interface TreeNode {
  entry: Entry;
  children: TreeNode[];
  issue?: string;
}

export interface ScanResult {
  roots: TreeNode[];
  folders: number;
  foldersRead: number;
  files: number;
  issues: number;
}

export interface ScanOptions {
  maxFolders: number;
  maxDepth: number;
  maxItems: number;
}

export interface FolderReader {
  roots(): Promise<Entry[]>;
  contents(id: number): Promise<Entry[]>;
}

function sorted(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    Number(b.isFolder) - Number(a.isFolder) ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) ||
    a.id - b.id,
  );
}

export async function scanFolders(reader: FolderReader, options: ScanOptions): Promise<ScanResult> {
  const rootEntries = await reader.roots();
  if (rootEntries.length > options.maxItems) {
    throw new ShufflrrError("limit", "Root folder list exceeds the configured item limit.");
  }
  const result: ScanResult = {
    roots: sorted(rootEntries).map(entry => ({ entry, children: [] })),
    folders: rootEntries.length, foldersRead: 0, files: 0, issues: 0,
  };
  const stack = result.roots.map(node => ({ node, depth: 0 })).reverse();
  const seen = new Set<number>();
  let authenticationEnded = false;
  let foldersAttempted = 0;

  // Iterative traversal avoids overflowing the call stack on a deep hierarchy.
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    let issue: string | undefined;
    if (authenticationEnded) issue = "Not read: authentication ended";
    else if (seen.has(node.entry.id)) issue = "Not read: cycle or duplicate folder reference";
    else if (depth > options.maxDepth) issue = "Not read: depth limit reached";
    else if (foldersAttempted >= options.maxFolders) issue = "Not read: folder limit reached";
    if (issue) {
      node.issue = issue;
      result.issues++;
      continue;
    }
    seen.add(node.entry.id);
    foldersAttempted++;
    try {
      const contents = await reader.contents(node.entry.id);
      if (result.folders + result.files + contents.length > options.maxItems) {
        throw new ShufflrrError("limit", "Not read: item limit reached");
      }
      node.children = sorted(contents).map(entry => ({ entry, children: [] }));
      result.foldersRead++;
      for (const child of [...node.children].reverse()) {
        if (child.entry.isFolder) {
          result.folders++;
          stack.push({ node: child, depth: depth + 1 });
        } else {
          result.files++;
        }
      }
    } catch (error) {
      if (!(error instanceof ShufflrrError)) throw error;
      node.issue = error.message;
      result.issues++;
      if (error.code === "authentication") authenticationEnded = true;
    }
  }
  return result;
}

// File names are untrusted terminal input: escape control codes and bidi controls.
export function terminalText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, character =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

export function renderTree(result: ScanResult, ascii = false): string {
  const lines = ["Shufflrr/"];
  const pending = result.roots.map((node, index) => ({
    node, prefix: "", last: index === result.roots.length - 1,
  })).reverse();
  if (result.roots.length === 0) lines.push("  (No accessible root folders)");
  while (pending.length) {
    const { node, prefix, last } = pending.pop()!;
    const branch = ascii ? (last ? "`-- " : "|-- ") : (last ? "└── " : "├── ");
    const permissions = node.entry.userPermissions === undefined
      ? "" : ` [reported: ${terminalText(String(node.entry.userPermissions))}]`;
    lines.push(prefix + branch + terminalText(node.entry.name) +
      (node.entry.isFolder ? "/" : "") + permissions +
      (node.issue ? ` [${terminalText(node.issue)}]` : ""));
    const childPrefix = prefix + (last ? "    " : ascii ? "|   " : "│   ");
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({ node: node.children[i], prefix: childPrefix, last: i === node.children.length - 1 });
    }
  }
  return lines.join("\n");
}
