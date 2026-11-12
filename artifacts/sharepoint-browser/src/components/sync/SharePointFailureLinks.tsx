import { useState } from "react";
import { ExternalLink, FolderOpen, Loader2 } from "lucide-react";
import { getSyncFailureSharePointLink } from "@workspace/api-client-react";

/** Resolve on click so status polling does not repeatedly query Microsoft Graph. */
export function SharePointFailureLinks({ failureId }: { failureId: number }) {
  const [pending, setPending] = useState<"file" | "folder" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);

  const openTarget = async (target: "file" | "folder") => {
    setPending(target);
    setError(null);
    setReadyUrl(null);
    // Reserve a tab during the user gesture, before the asynchronous lookup.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const { url } = await getSyncFailureSharePointLink(failureId, target);
      if (tab && !tab.closed) tab.location.replace(url);
      else setReadyUrl(url);
    } catch (cause) {
      tab?.close();
      setError(cause instanceof Error ? cause.message : "The SharePoint link could not be resolved. Try again.");
    } finally {
      setPending(null);
    }
  };

  return <>
    {(["file", "folder"] as const).map(target => {
      const Icon = pending === target ? Loader2 : target === "file" ? ExternalLink : FolderOpen;
      return <button key={target} type="button" disabled={pending !== null}
        onClick={() => void openTarget(target)}
        className="inline-flex items-center gap-1 underline disabled:opacity-50"
        data-testid={`button-open-sharepoint-${target}-${failureId}`}>
        <Icon className={`size-3 ${pending === target ? "animate-spin" : ""}`} aria-hidden="true" />
        {pending === target ? "Finding target…" : `Open target ${target} in SharePoint`}
      </button>;
    })}
    {error && <span role="alert" className="basis-full text-destructive">{error}</span>}
    {readyUrl && <a href={readyUrl} target="_blank" rel="noopener noreferrer"
      className="basis-full underline" data-testid={`link-sharepoint-ready-${failureId}`}>
      Open SharePoint target (allow pop-ups for automatic opening)
    </a>}
  </>;
}
