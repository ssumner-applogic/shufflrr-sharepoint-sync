import { useRef, useState } from "react";
import { Loader2, Unplug } from "lucide-react";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { SyncConfig } from "@workspace/api-client-react";

export function SyncDisconnectControl({ config, busy, blockedReason, error, onConfirm }: {
  config: SyncConfig | undefined;
  busy: boolean;
  blockedReason: string | null;
  error: string | null;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const help = !config?.configured ? "No saved folders are connected."
    : blockedReason ?? "Existing SharePoint files, notices, and sync history will be kept.";
  return (
    <div className="shrink-0 border-t bg-card px-4 py-3">
      <AlertDialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
        <AlertDialogTrigger asChild>
          <button
            type="button"
            disabled={!config?.configured || !!blockedReason || busy}
            aria-describedby="disconnect-sync-help"
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="button-disconnect-sync"
          >
            <Unplug className="size-4" aria-hidden="true" />
            Disconnect folders
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent onCloseAutoFocus={event => {
          if (!config?.configured) { event.preventDefault(); statusRef.current?.focus(); }
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect saved sync folders?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears the saved Shufflrr selections and SharePoint target, cancels queued retries, and keeps sync paused.
              No files will be deleted. Existing SharePoint copies, file mappings, notices, and activity history are kept.
              You can save a new mapping later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-words text-sm">
            SharePoint target: <strong>{config?.destinationFolderName}</strong>
            <br />
            Shufflrr: {config?.sourceFolders.map(folder => folder.name).join(", ")}
          </p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {blockedReason && <p role="status" className="text-sm text-muted-foreground">{blockedReason}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <button
              type="button"
              disabled={busy || !!blockedReason || !config?.configured}
              onClick={async () => {
                try { await onConfirm(); setOpen(false); }
                catch { /* The mutation's safe error is displayed above; keep confirmation open. */ }
              }}
              aria-busy={busy}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
              data-testid="button-confirm-disconnect-sync"
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {busy ? "Disconnecting…" : "Disconnect folders"}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <p id="disconnect-sync-help" ref={statusRef} tabIndex={-1} className="mt-2 text-xs text-muted-foreground">{help}</p>
      {!open && error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
