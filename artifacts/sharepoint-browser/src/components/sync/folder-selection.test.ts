import { test } from "node:test";
import assert from "node:assert/strict";
import { currentExclusionAncestors, folderSelectionState, toggleFolderSelection } from "./folder-selection";
import type { SyncFolderExclusion, SyncSourceFolder } from "@workspace/api-client-react";

const roots = new Map<number, SyncSourceFolder>([[1, { id: 1, name: "Source" }]]);
const parents = new Map([[2, 1], [3, 2], [4, 1]]);
const none = new Map<number, SyncFolderExclusion>();
const child = { id: 2, name: "Child" };

test("all levels inherit a selected parent without additional explicit root selections", () => {
  assert.equal(folderSelectionState(2, [1], roots, none, parents).checked, true);
  assert.equal(folderSelectionState(3, [1, 2], roots, none, parents).inherited, true);
  assert.equal(folderSelectionState(4, [1], roots, none, parents).checked, true);
});
test("unchecking an inherited folder excludes its entire subtree and makes ancestors mixed", () => {
  const next = toggleFolderSelection(child, [1], false, roots, none, parents);
  assert.deepEqual([...next.roots.keys()], [1]);
  assert.deepEqual(next.exclusions.get(2), { ...child, rootId: 1, ancestorIds: [1] });
  assert.equal(folderSelectionState(1, [], next.roots, next.exclusions, parents).indeterminate, true);
  assert.equal(folderSelectionState(2, [1], next.roots, next.exclusions, parents).checked, false);
  const grandchild = folderSelectionState(3, [1, 2], next.roots, next.exclusions, parents);
  assert.equal(grandchild.checked, false);
  assert.equal(grandchild.excludedByAncestor, true);
  assert.equal(folderSelectionState(4, [1], next.roots, next.exclusions, parents).checked, true);
});
test("restored serialized exclusions mark ancestors mixed before excluded branches load", () => {
  const saved = new Map<number, SyncFolderExclusion>([[3, { id: 3, name: "Deep", rootId: 1, ancestorIds: [1, 2] }]]);
  assert.equal(folderSelectionState(1, [], roots, saved, new Map()).indeterminate, true);
  assert.equal(folderSelectionState(2, [1], roots, saved, new Map()).indeterminate, true);
});
test("rechecking an excluded subtree restores inherited selection at all depths", () => {
  const removed = toggleFolderSelection(child, [1], false, roots, none, parents);
  const restored = toggleFolderSelection(child, [1], true, removed.roots, removed.exclusions, parents);
  assert.equal(restored.exclusions.size, 0);
  assert.equal(folderSelectionState(3, [1, 2], restored.roots, restored.exclusions, parents).checked, true);
});
test("an excluded ancestor cannot be bypassed by selecting a descendant", () => {
  const removed = toggleFolderSelection(child, [1], false, roots, none, parents);
  const next = toggleFolderSelection({ id: 3, name: "Deep" }, [1, 2], true, roots, removed.exclusions, parents);
  assert.deepEqual([...next.roots.keys()], [1]);
  assert.deepEqual([...next.exclusions.keys()], [2]);
});
test("excluding a broader subtree removes redundant nested exclusions; removing a root clears its exclusions", () => {
  const deep = toggleFolderSelection({ id: 3, name: "Deep" }, [1, 2], false, roots, none, parents);
  const broader = toggleFolderSelection(child, [1], false, roots, deep.exclusions, parents);
  assert.deepEqual([...broader.exclusions.keys()], [2]);
  const removed = toggleFolderSelection({ id: 1, name: "Source" }, [], false, roots, broader.exclusions, parents);
  assert.equal(removed.roots.size, 0);
  assert.equal(removed.exclusions.size, 0);
});
test("choosing a parent replaces explicitly selected nested roots", () => {
  const childRoots = new Map([[2, child]]);
  const selected = toggleFolderSelection({ id: 1, name: "Source" }, [], true, childRoots, none, parents);
  assert.deepEqual([...selected.roots.keys()], [1]);
});

test("a moved exclusion uses freshly loaded ancestry in the tree and the next save", () => {
  const movedParents = new Map([[2, 1], [3, 4], [4, 1]]);
  const moved = { id: 3, name: "Deep", rootId: 1, ancestorIds: [1, 2] };
  const exclusions = new Map([[3, moved]]);
  assert.deepEqual(currentExclusionAncestors(moved, movedParents), [1, 4]);
  assert.equal(folderSelectionState(2, [1], roots, exclusions, movedParents).indeterminate, false);
  assert.equal(folderSelectionState(4, [1], roots, exclusions, movedParents).indeterminate, true);
});
