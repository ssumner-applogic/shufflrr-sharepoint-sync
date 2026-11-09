import { useMemo } from "react";
import { useListShufflrrItems, getListShufflrrItemsQueryKey } from "@workspace/api-client-react";
import { mergePages } from "@/components/tree/tree-utils";
import { SHUFFLRR_STALE_MS } from "./format";

export function useShufflrrBranch(folderId: number | undefined, active: boolean) {
  const params = folderId ? { folderId } : undefined;
  const query = useListShufflrrItems(params, {
    query: { queryKey: getListShufflrrItemsQueryKey(params), enabled: active, staleTime: SHUFFLRR_STALE_MS },
  });
  const items = useMemo(() => mergePages([query.data?.items ?? []]), [query.data]);
  return { query, items };
}
