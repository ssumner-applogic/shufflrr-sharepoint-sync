import { useEffect, useRef, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { getLookupFileMetadataQueryKey, useLookupFileMetadata, type LookupFileMetadataParams } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { MetadataDetails } from "./MetadataDetails";

type FileIdentity = { sourceFileId: number; itemId?: never } | { itemId: string; sourceFileId?: never };

export function FileMetadataButton({ name, identity }: { name: string; identity: FileIdentity }) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    // Large expanded trees should only check metadata for rows near the viewport.
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "100px" });
    observer.observe(button);
    return () => observer.disconnect();
  }, []);
  const params: LookupFileMetadataParams = identity;
  const query = useLookupFileMetadata(params, {
    query: {
      queryKey: getLookupFileMetadataQueryKey(params),
      enabled: visible || open,
      retry: false,
      staleTime: 30_000,
      refetchInterval: open ? 30_000 : visible ? 60_000 : false,
    },
  });
  const notFound = query.isError && query.error.status === 404;
  const available = query.data?.fields != null && !query.isError;
  const availability = available
    ? "Shufflrr metadata available"
    : query.isPending
      ? "Checking Shufflrr metadata availability"
      : query.isError && !notFound
        ? "Could not check Shufflrr metadata; click to retry"
        : "No captured Shufflrr metadata available";
  const testId = `file-info-${identity.sourceFileId !== undefined ? `shufflrr-${identity.sourceFileId}` : `sharepoint-${identity.itemId}`}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button ref={buttonRef} type="button" data-tree-action data-testid={testId}
          data-metadata-available={available}
          title={availability} aria-label={`${availability}: ${name}`}
          onClick={event => {
            event.stopPropagation();
            if (query.isError) void query.refetch();
          }}
          className={`inline-flex size-5 shrink-0 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            available
              ? "text-green-700 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300"
              : "text-muted-foreground/50 hover:text-muted-foreground"
          }`}>
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
