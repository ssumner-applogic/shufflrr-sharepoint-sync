import { Loader2, RotateCw } from "lucide-react";
import { errorMessage } from "@/components/shufflrr/format";
import { indentStyle } from "./TreeView";

const pad = (level: number) => ({ paddingLeft: `calc(${indentStyle(level).paddingLeft} + 1.5rem)` });

export function BranchLoading({ level, testId }: { level: number; testId: string }) {
  return (
    <li role="none" aria-busy="true" data-testid={testId}>
      <span
        role="status"
        className="flex items-center gap-2 py-2 pr-3 text-xs text-muted-foreground"
        style={pad(level)}
      >
        Loading folder contents…
      </span>
    </li>
  );
}

export function BranchNote({ level, text, testId }: { level: number; text: string; testId: string }) {
  return <li role="none" className="py-2 pr-3 text-xs text-muted-foreground" style={pad(level)} data-testid={testId}>{text}</li>;
}

export function BranchError({
  level, title, error, onRetry, onAccessTest, testId, retryTestId, accessTestId,
}: {
  level: number; title: string; error: unknown; onRetry: () => void; onAccessTest: () => void;
  testId: string; retryTestId: string; accessTestId: string;
}) {
  const advice = (error as { data?: { advice?: unknown } | null } | null)?.data?.advice;
  return (
    <li role="none" className="py-3 pr-3 text-sm" style={pad(level)}>
      <div role="alert" data-testid={testId}>
        <div className="font-medium text-destructive">{title}</div>
        <div className="mt-1 break-words text-muted-foreground">{errorMessage(error)}</div>
        {Array.isArray(advice) && advice.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5">{advice.map((a, i) => <li key={i}>{String(a)}</li>)}</ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onAccessTest} className="rounded border px-3 py-1 hover:bg-secondary" data-testid={accessTestId}>Go to Access Test</button>
          <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded border px-3 py-1 hover:bg-secondary" data-testid={retryTestId}>
            <RotateCw className="size-3.5" aria-hidden="true" /> Retry
          </button>
        </div>
      </div>
    </li>
  );
}

export function BranchLoadMore({ level, shown, loading, onClick, testId }: { level: number; shown: number; loading: boolean; onClick: () => void; testId: string }) {
  return (
    <li role="none" className="flex flex-wrap items-center gap-3 py-2 pr-3 text-xs" style={pad(level)}>
      <button type="button" onClick={onClick} disabled={loading} className="inline-flex items-center gap-1.5 rounded border px-2.5 py-1 hover:bg-secondary disabled:opacity-50" data-testid={testId}>
        {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
        {loading ? "Loading" : "Load more"}
      </button>
      <span className="font-mono text-muted-foreground">{shown} shown, more available</span>
    </li>
  );
}
