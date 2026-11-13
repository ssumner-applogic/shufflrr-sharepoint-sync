import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  getGetMetadataStatusQueryKey, useGetMetadataStatus, useSetMetadataInterval,
  type MetadataStatus,
} from "@workspace/api-client-react";

const intervals = [300, 600, 900, 3600] as const;

export function MetadataSyncInterval({ active }: { active: boolean }) {
  const client = useQueryClient();
  const [saved, setSaved] = useState(false);
  const status = useGetMetadataStatus({
    query: { queryKey: getGetMetadataStatusQueryKey(), enabled: active, refetchInterval: active ? 5000 : false },
  });
  const mutation = useSetMetadataInterval({
    mutation: {
      onSuccess: async schedule => {
        const key = getGetMetadataStatusQueryKey();
        await client.cancelQueries({ queryKey: key });
        client.setQueryData<MetadataStatus>(key, previous => previous ? { ...previous, ...schedule } : previous);
        await client.invalidateQueries({ queryKey: key });
        setSaved(true);
      },
    },
  });
  return (
    <div className="min-w-0">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Metadata Sync
        <select
          aria-label="Metadata Sync interval"
          title="Saved automatically for all workers. Metadata also refreshes after file-sync changes. Changing this interval does not change file polling or interrupt a running refresh."
          data-testid="select-metadata-sync-interval"
          value={status.data?.intervalSeconds ?? ""}
          disabled={!active || !status.data || status.isError || mutation.isPending}
          onChange={event => {
            const intervalSeconds = intervals.find(value => value === Number(event.target.value));
            if (intervalSeconds !== undefined) {
              setSaved(false);
              mutation.mutate({ data: { intervalSeconds } });
            }
          }}
          className="h-9 rounded-md border bg-card px-2 text-sm text-foreground disabled:opacity-50"
        >
          {!status.data && <option value="">Loading…</option>}
          {status.data && !intervals.some(value => value === status.data.intervalSeconds) &&
            <option value={status.data.intervalSeconds} disabled>Current: {status.data.intervalSeconds / 60} min</option>}
          {intervals.map(value => <option key={value} value={value}>{value / 60} min</option>)}
        </select>
        {mutation.isPending && <Loader2 className="size-4 animate-spin" aria-label="Saving metadata interval" />}
      </label>
      {saved && !mutation.isPending && <span className="sr-only" role="status">Metadata Sync interval saved.</span>}
      {(status.isError || mutation.isError) && (
        <p className="mt-1 max-w-64 text-xs text-destructive" role="alert">
          {mutation.isError ? "Could not save metadata interval. Try again." : "Could not load metadata schedule."}
          {status.isError && <button type="button" data-testid="button-retry-metadata-schedule"
            className="ml-1 underline" onClick={() => void status.refetch()}>Retry</button>}
        </p>
      )}
    </div>
  );
}
