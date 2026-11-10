import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSharePointFolder,
  deleteSharePointItem,
  listItems,
  updateSharePointItem,
  type LibraryItem,
} from "@workspace/api-client-react";
import { Folder, FolderPlus, Home, Loader2, MoveRight, Pencil, Trash2, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type SelectedSharePointItem = {
  item: LibraryItem;
  ancestorIds: string[];
};

type DialogMode = "create" | "rename" | "move" | "delete" | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed.";
}

function safeName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !!name.trim() && !/[\\/\u0000-\u001f\u007f]/.test(name);
}

function getTopLevelSelection(selected: SelectedSharePointItem[]): SelectedSharePointItem[] {
  const selectedFolders = new Set(selected.filter((entry) => entry.item.isFolder).map((entry) => entry.item.id));
  return selected.filter((entry) =>
    !entry.ancestorIds.some((ancestorId) => selectedFolders.has(ancestorId)),
  );
}

function getCoveredIds(entry: SelectedSharePointItem, selected: SelectedSharePointItem[]): string[] {
  if (!entry.item.isFolder) return [entry.item.id];
  return selected
    .filter((candidate) =>
      candidate.item.id === entry.item.id || candidate.ancestorIds.includes(entry.item.id),
    )
    .map((candidate) => candidate.item.id);
}

async function loadFolders(folderId: string | undefined, signal: AbortSignal): Promise<LibraryItem[]> {
  const folders: LibraryItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount < 20; pageCount++) {
    const page = await listItems(
      { ...(folderId ? { folderId } : {}), ...(cursor ? { cursor } : {}) },
      { signal },
    );
    folders.push(...page.items.filter((item) => item.isFolder));
    if (folders.length > 2000) throw new Error("This folder has too many subfolders to display here.");
    cursor = page.nextCursor;
    if (!cursor) break;
    if (seenCursors.has(cursor)) throw new Error("SharePoint returned a repeated folder-list page.");
    seenCursors.add(cursor);
    if (pageCount === 19) throw new Error("This folder has too many pages to display here.");
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

function MoveTargetDialog({
  open,
  onOpenChange,
  selected,
  busy,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: SelectedSharePointItem[];
  busy: boolean;
  onChoose: (parentId: string | null) => void;
}) {
  const [path, setPath] = useState<LibraryItem[]>([]);
  useEffect(() => {
    if (open) setPath([]);
  }, [open]);
  const folderId = path.at(-1)?.id;
  const folders = useQuery({
    queryKey: ["sharepoint-move-folders", folderId ?? null],
    queryFn: ({ signal }) => loadFolders(folderId, signal),
    enabled: open,
    staleTime: 30_000,
  });
  const selectedFolders = useMemo(
    () => new Set(selected.filter((entry) => entry.item.isFolder).map((entry) => entry.item.id)),
    [selected],
  );
  const destinationIsInsideSelection = path.some((folder) => selectedFolders.has(folder.id));

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent data-testid="dialog-move-items">
        <DialogHeader>
          <DialogTitle>Move {selected.length} selected {selected.length === 1 ? "item" : "items"}</DialogTitle>
          <DialogDescription>Choose a destination in the Shared Documents library.</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {path.length > 0 && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onChoose(null)}
                data-testid="button-move-to-root"
              >
                <Home aria-hidden="true" />
                Move to Shared Documents root
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setPath((current) => current.slice(0, -1))}
                data-testid="button-move-back"
              >
                Back
              </Button>
            </>
          )}
          <span className="truncate text-muted-foreground" data-testid="text-move-location">
            Shared Documents{path.map((folder) => ` / ${folder.name}`)}
          </span>
        </div>
        {destinationIsInsideSelection && (
          <p className="text-sm text-destructive" role="alert" data-testid="error-move-descendant">
            A folder cannot be moved into itself or one of its subfolders.
          </p>
        )}
        <div className="max-h-64 overflow-y-auto rounded-md border" aria-label="Destination folders">
          {folders.isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">...</p>
          ) : folders.isError ? (
            <p className="p-4 text-sm text-destructive" role="alert">
              {errorMessage(folders.error)}
            </p>
          ) : folders.data?.length ? (
            <ul className="divide-y">
              {folders.data.map((folder) => (
                <li key={folder.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
                    disabled={busy}
                    onClick={() => setPath((current) => [...current, folder])}
                    data-testid={`button-browse-folder-${folder.id}`}
                  >
                    <Folder className="size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                    <MoveRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">No subfolders here.</p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)} data-testid="button-cancel-move">
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || destinationIsInsideSelection || folders.isError}
            onClick={() => onChoose(folderId ?? null)}
            data-testid="button-confirm-move"
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <MoveRight aria-hidden="true" />}
            {folderId ? "Move to this folder" : "Move to Shared Documents root"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SharePointItemActions({
  selectedItems,
  onComplete,
}: {
  selectedItems: SelectedSharePointItem[];
  onComplete: (ids: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [folderName, setFolderName] = useState("");
  const [renamedItems, setRenamedItems] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [formError, setFormError] = useState("");
  const selectedFolder = selectedItems.length === 1 && selectedItems[0].item.isFolder
    ? selectedItems[0]
    : undefined;
  const operationTargets = useMemo(() => getTopLevelSelection(selectedItems), [selectedItems]);
  const invalidRenameName = selectedItems.some(({ item }) => !safeName(renamedItems[item.id] ?? ""));
  const invalidFolderName = folderName.length > 0 && !safeName(folderName);

  async function refreshAfterMutation(successfulIds: string[]) {
    await queryClient.invalidateQueries({ queryKey: ["sharepoint-tree"] });
    onComplete(successfulIds);
  }

  async function runBatch(
    targets: SelectedSharePointItem[],
    operation: (entry: SelectedSharePointItem) => Promise<unknown>,
    clearsDescendants: boolean,
    label: string,
  ) {
    if (busy || targets.length === 0) return;
    setBusy(true);
    setFeedback("");
    const successfulIds: string[] = [];
    const failures: string[] = [];
    try {
      for (const entry of targets) {
        try {
          await operation(entry);
          successfulIds.push(...(clearsDescendants ? getCoveredIds(entry, selectedItems) : [entry.item.id]));
        } catch (error) {
          failures.push(`${entry.item.name}: ${errorMessage(error)}`);
        }
      }
      await refreshAfterMutation(successfulIds);
      setDialog(null);
      setFeedback(
        failures.length
          ? `${label}: ${successfulIds.length} completed; ${failures.length} failed. ${failures[0]}`
          : `${label}: ${targets.length} completed.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function createFolder() {
    if (busy || !safeName(folderName)) return;
    setBusy(true);
    setFeedback("");
    setFormError("");
    try {
      await createSharePointFolder({ name: folderName, parentId: selectedFolder?.item.id ?? null });
      await queryClient.invalidateQueries({ queryKey: ["sharepoint-tree"] });
      setDialog(null);
      setFolderName("");
      setFeedback("Folder created.");
    } catch (error) {
      setFormError(`Folder was not created. ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function beginRename() {
    setRenamedItems(Object.fromEntries(selectedItems.map(({ item }) => [item.id, item.name])));
    setDialog("rename");
  }

  async function renameItems() {
    if (invalidRenameName) return;
    setFormError("");
    await runBatch(
      selectedItems.filter(({ item }) => renamedItems[item.id] !== item.name),
      (entry) => updateSharePointItem(entry.item.id, { name: renamedItems[entry.item.id] }),
      false,
      "Rename",
    );
  }

  async function moveItems(parentId: string | null) {
    await runBatch(
      operationTargets,
      (entry) => updateSharePointItem(entry.item.id, { parentId }),
      true,
      "Move",
    );
  }

  async function deleteItems() {
    await runBatch(
      operationTargets,
      (entry) => deleteSharePointItem(entry.item.id),
      true,
      "Delete",
    );
  }

  return (
    <div className="space-y-2 border-b px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => { setFolderName(""); setDialog("create"); }}
          data-testid="button-new-sharepoint-folder"
        >
          <FolderPlus aria-hidden="true" />
          {selectedFolder ? "New subfolder" : "New folder"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || !selectedItems.length} onClick={beginRename} data-testid="button-rename-sharepoint-items">
          <Pencil aria-hidden="true" /> Rename
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || !operationTargets.length} onClick={() => setDialog("move")} data-testid="button-move-sharepoint-items">
          <MoveRight aria-hidden="true" /> Move
        </Button>
        <Button type="button" size="sm" variant="destructive" disabled={busy || !operationTargets.length} onClick={() => setDialog("delete")} data-testid="button-delete-sharepoint-items">
          <Trash2 aria-hidden="true" /> Delete
        </Button>
        {selectedItems.length > 0 && (
          <>
            <span className="text-sm text-muted-foreground" data-testid="text-sharepoint-selection-count">
              {selectedItems.length} selected
            </span>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onComplete(selectedItems.map(({ item }) => item.id))} data-testid="button-clear-sharepoint-selection">
              <X aria-hidden="true" /> Clear
            </Button>
          </>
        )}
      </div>
      {selectedItems.length > 100 && (
        <p className="text-sm text-destructive" role="alert" data-testid="error-sharepoint-selection-limit">
          Select 100 or fewer items at a time.
        </p>
      )}
      {feedback && <p className="text-sm" role="status" data-testid="status-sharepoint-action">{feedback}</p>}

      <Dialog open={dialog === "create"} onOpenChange={(open) => !busy && setDialog(open ? "create" : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedFolder ? "Create subfolder" : "Create folder"}</DialogTitle>
            <DialogDescription>
              Destination: {selectedFolder ? selectedFolder.item.name : "Shared Documents root"}.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            maxLength={255}
            value={folderName}
            onChange={(event) => { setFolderName(event.currentTarget.value); setFormError(""); }}
            onKeyDown={(event) => { if (event.key === "Enter") void createFolder(); }}
            placeholder="Folder name"
            aria-label="New folder name"
            data-testid="input-new-sharepoint-folder-name"
          />
          {formError && dialog === "create" && <p role="alert" className="text-sm text-destructive" data-testid="error-create-folder">{formError}</p>}
          {invalidFolderName && <p role="alert" className="text-sm text-destructive" data-testid="error-invalid-folder-name">Use 1–255 characters, without slashes or control characters.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)} data-testid="button-cancel-create-folder">Cancel</Button>
            <Button type="button" disabled={busy || !safeName(folderName)} onClick={() => void createFolder()} data-testid="button-confirm-create-folder">
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "rename"} onOpenChange={(open) => !busy && setDialog(open ? "rename" : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {selectedItems.length} selected {selectedItems.length === 1 ? "item" : "items"}</DialogTitle>
            <DialogDescription>Enter a new name for each selected item.</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-3 overflow-y-auto">
            {selectedItems.map(({ item }) => (
              <label key={item.id} className="block space-y-1 text-sm">
                <span className="block truncate text-muted-foreground">{item.name}</span>
                <Input
                  maxLength={255}
                  value={renamedItems[item.id] ?? ""}
                  onChange={(event) => { setRenamedItems((current) => ({ ...current, [item.id]: event.currentTarget.value })); setFormError(""); }}
                  aria-label={`New name for ${item.name}`}
                  data-testid={`input-rename-sharepoint-item-${item.id}`}
                />
              </label>
            ))}
          </div>
          {invalidRenameName && <p role="alert" className="text-sm text-destructive" data-testid="error-rename-items">Each name must be 1–255 characters, without slashes or control characters.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)} data-testid="button-cancel-rename">Cancel</Button>
            <Button type="button" disabled={busy || selectedItems.length > 100 || invalidRenameName} onClick={() => void renameItems()} data-testid="button-confirm-rename">
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />} Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MoveTargetDialog
        open={dialog === "move"}
        onOpenChange={(open) => setDialog(open ? "move" : null)}
        selected={operationTargets}
        busy={busy}
        onChoose={(parentId) => void moveItems(parentId)}
      />

      <AlertDialog open={dialog === "delete"} onOpenChange={(open) => !busy && setDialog(open ? "delete" : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {operationTargets.length} selected {operationTargets.length === 1 ? "item" : "items"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This changes the live SharePoint library. Deleting a folder also deletes its contents. Items covered by a selected parent folder are included once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-sm" data-testid="list-delete-sharepoint-items">
            {operationTargets.map(({ item }) => <li key={item.id} className="break-words">{item.name}{item.isFolder ? " (folder and contents)" : ""}</li>)}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || operationTargets.length > 100}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void deleteItems()}
              data-testid="button-confirm-delete"
            >
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
