import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { listItems } from "@workspace/api-client-react";
import { TREE_STALE_MS, mergePages } from "@/components/tree/tree-utils";

/** Distinct from generated useListItems keys, since this cache entry holds InfiniteData. */
export const sharePointTreeKey = (folderId?: string) => ["sharepoint-tree", folderId ?? null] as const;

export function useSharePointBranch(folderId: string | undefined, active: boolean) {
  const query = useInfiniteQuery({
    queryKey: sharePointTreeKey(folderId),
    queryFn: ({ pageParam, signal }) =>
      listItems({ ...(folderId ? { folderId } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last, _all, lastParam) =>
      last.nextCursor && last.nextCursor !== lastParam ? last.nextCursor : undefined,
    enabled: active,
    staleTime: TREE_STALE_MS,
  });
  const items = useMemo(() => mergePages((query.data?.pages ?? []).map((p) => p.items)), [query.data]);
  return { query, items };
}
