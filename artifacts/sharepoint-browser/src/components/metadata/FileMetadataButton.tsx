import { useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { useLookupFileMetadata, type LookupFileMetadataParams } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { MetadataDetails } from "./MetadataDetails";

type FileIdentity = { sourceFileId: number; itemId?: never } | { itemId: string; sourceFileId?: never };

export function FileMetadataButton({ name, identity }: { name: string; identity: FileIdentity }) {
  const [open, setOpen] = useState(false);
  const params: LookupFileMetadataParams = identity;
  const query = useLookupFileMetadata(params, {
    query: { enabled: open, retry: false, staleTime: 0, refetchInterval: open ? 30_000 : false },
  });
  const notFound = query.isError && query.error.status === 404;
  const testId = `file-info-${identity.sourceFileId !== undefined ? `shufflrr-${identity.sourceFileId}` : `sharepoint-${identity.itemId}`}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" data-tree-action data-testid={testId}
          title="Shufflrr file information" aria-label={`Show Shufflrr metadata for ${name}`}
          onClick={event => event.stopPropagation()}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Info className="size-3.5" aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100%_-_2rem)] sm:max-w-xl"
        onClick={event => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Shufflrr file information</DialogTitle>
          <DialogDescription className="break-words pr-4">{name}</DialogDescription>
        </DialogHeader>
        {query.isPending && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Loading metadata…</p>}
        {query.isError && (
          <div className="space-y-2 text-sm" role={notFound ? "status" : "alert"}>
            <p className={notFound ? "text-muted-foreground" : "text-destructive"}>
              {notFound
                ? "No Shufflrr metadata has been captured for this file in the configured sync scope. Files outside that scope or not yet synchronized may have no snapshot."
                : "Could not load file metadata. Check your connection and try again."}
            </p>
            {notFound && <p className="text-xs text-muted-foreground">For synchronized files, use Refresh metadata under Sync Agent → Metadata activity.</p>}
            <button type="button" className="text-xs underline" onClick={() => void query.refetch()}>Try again</button>
          </div>
        )}
        {query.data && !query.isError && <MetadataDetails record={query.data} />}
      </DialogContent>
    </Dialog>
  );
}
