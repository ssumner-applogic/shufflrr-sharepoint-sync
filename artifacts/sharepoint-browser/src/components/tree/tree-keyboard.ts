import type { FocusEvent, KeyboardEvent } from "react";

const ITEM = '[role="treeitem"]';

export function visibleItems(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM));
}

export function focusItem(root: HTMLElement, el: HTMLElement | undefined) {
  if (!el) return;
  for (const i of visibleItems(root)) i.tabIndex = i === el ? 0 : -1;
  el.focus();
}

/** Keeps exactly one tab stop in the tree, even after the focused branch collapses. */
export function ensureRovingTabStop(root: HTMLElement) {
  const items = visibleItems(root);
  if (items.length && !items.some((i) => i.tabIndex === 0)) items[0].tabIndex = 0;
}

export function syncTabStopOnFocus(e: FocusEvent<HTMLElement>) {
  const t = e.target as HTMLElement;
  if (t.getAttribute("role") !== "treeitem") return;
  for (const i of visibleItems(e.currentTarget)) i.tabIndex = i === t ? 0 : -1;
}

export function handleTreeKeyDown(e: KeyboardEvent<HTMLElement>, onToggle: (key: string) => void) {
  const root = e.currentTarget;
  const cur = e.target as HTMLElement;
  if (cur.getAttribute("role") !== "treeitem") return;
  const items = visibleItems(root);
  const idx = items.indexOf(cur);
  const key = cur.dataset.treeKey;
  const expanded = cur.getAttribute("aria-expanded");

  switch (e.key) {
    case "ArrowDown": focusItem(root, items[idx + 1]); break;
    case "ArrowUp": if (idx > 0) focusItem(root, items[idx - 1]); break;
    case "Home": focusItem(root, items[0]); break;
    case "End": focusItem(root, items[items.length - 1]); break;
    case "ArrowRight":
      if (expanded === "false" && key) onToggle(key);
      else if (expanded === "true") focusItem(root, cur.querySelector<HTMLElement>(`:scope > [role="group"] > ${ITEM}`) ?? undefined);
      break;
    case "ArrowLeft":
      if (expanded === "true" && key) onToggle(key);
      else {
        const parent = cur.parentElement?.closest<HTMLElement>(ITEM);
        if (parent && root.contains(parent)) focusItem(root, parent);
      }
      break;
    case "Enter":
    case " ":
      if (expanded !== null && key) onToggle(key);
      else cur.querySelector<HTMLElement>(":scope > .tree-row [data-tree-action]")?.click();
      break;
    default:
      return;
  }
  e.preventDefault();
}
