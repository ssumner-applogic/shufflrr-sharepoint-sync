import { ExternalLink, Loader2 } from "lucide-react";
import { ShufflrrTree } from "./ShufflrrTree";
import { useShufflrrBranch } from "./use-shufflrr-branch";

export function ShufflrrViewer({ active, onAccessTest }: { active: boolean; onAccessTest: () => void }) {
  const { query: root } = useShufflrrBranch(undefined, active);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Shufflrr Viewer</h2>
        </div>
        {root.data?.portalUrl && (
          <a href={root.data.portalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm hover:bg-secondary" data-testid="link-shufflrr-portal">
            <ExternalLink className="size-4" /> Shufflrr portal
          </a>
        )}
      </div>
      <section className="min-w-0 rounded-lg border bg-card" data-testid="shufflrr-browser">
        <div className="flex items-center gap-2 border-b px-4 py-3 text-sm">
          <span className="font-medium">Roots</span>
          {root.isFetching && !root.isLoading && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" aria-label="Refreshing" />}
        </div>
        <ShufflrrTree active={active} onAccessTest={onAccessTest} />
      </section>
    </>
  );
}
