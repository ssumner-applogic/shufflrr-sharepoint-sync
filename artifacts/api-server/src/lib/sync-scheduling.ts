import { sql } from "drizzle-orm";
import { syncConfigTable } from "@workspace/db/schema";

/** Runtime bookkeeping is not a new user Start/Sync now request. */
export const preserveSyncControlTimestamp = () => sql`${syncConfigTable.updatedAt}`;

/** Keep a genuine control request made during a run, otherwise wait the saved interval. */
export function nextSyncAfterCompletion(controlUpdatedAt?: Date, retryAt?: Date) {
  const cooldown = retryAt ?? new Date(0);
  const scheduled = sql`greatest(now() + ${syncConfigTable.pollIntervalSeconds} * interval '1 second', ${cooldown}::timestamptz)`;
  return controlUpdatedAt
    ? sql`case when ${syncConfigTable.enabled}
        and date_trunc('milliseconds', ${syncConfigTable.updatedAt}) > ${controlUpdatedAt}::timestamptz
        then greatest(coalesce(${syncConfigTable.nextRunAt}, now()), ${cooldown}::timestamptz)
        else ${scheduled} end`
    : scheduled;
}
