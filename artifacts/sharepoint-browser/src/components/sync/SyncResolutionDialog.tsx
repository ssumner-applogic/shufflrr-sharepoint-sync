import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function SyncResolutionDialog({ choice, busy, error, onClose, onConfirm }: {
  choice: { action: "overwrite" | "ignore"; ids: number[] } | null;
  busy: boolean; error: unknown; onClose: () => void; onConfirm: () => void;
}) {
  const overwrite = choice?.action === "overwrite";
  return <AlertDialog open={!!choice} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{overwrite ? "Overwrite and synchronize" : "Ignore"} {choice?.ids.length} file{choice?.ids.length === 1 ? "" : "s"}?</AlertDialogTitle>
        <AlertDialogDescription>
          {overwrite
            ? "At the next sync, replace the existing SharePoint content with Shufflrr's version. After verification, these copies become managed by sync, including future source updates and deletions. The approved destination version is checked when the upload starts. No files change until a sync runs."
            : "Leave both copies untouched and stop future sync attempts for these files in this source/target mapping. The rules persist across sessions and renames. Review or re-enable them in Ignored files. Re-enabling never authorizes an overwrite."}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {!!error && <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : "The choices could not be saved."}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <button type="button" disabled={busy} onClick={onConfirm}
          className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${overwrite ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}
          data-testid="button-confirm-file-resolution">{busy ? "Saving…" : overwrite ? "Approve overwrite" : "Ignore files"}</button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
