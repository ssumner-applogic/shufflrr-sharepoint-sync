import { and, count, desc, eq, gt, inArray, isNull, not, sql } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import {
  syncConfigTable,
  syncFileFailureIssuesTable as issues,
  syncFileFailuresTable as failures,
  syncItemsTable,
} from "@workspace/db/schema";
import { GetSyncFailuresQueryParams, DismissSyncFileFailureParams, RetrySyncFileParams, RetryAllSyncFilesResponse,
  GetSyncFailureSharePointLinkParams, GetSyncFailureSharePointLinkResponse } from "@workspace/api-zod";
import { shufflrrFailureLinks } from "../lib/sync-file-failures";
import { SYNC_LOCK_ID } from "../lib/sync-runner";
import { AccessError, getSyncTargetUrl } from "../lib/sharepoint";

function inScope(row: typeof failures.$inferSelect, config: typeof syncConfigTable.$inferSelect | undefined) {
  return !!config && config.destinationFolderId === row.destinationRootId &&
    config.sourceFolders.some(folder => folder.id === row.sourceRootId) &&
    !config.excludedFolders.some(folder => folder.rootId === row.sourceRootId && row.ancestorIds.includes(folder.id));
}

function retryableScope(config: typeof syncConfigTable.$inferSelect | undefined) {
  if (!config?.destinationFolderId || !config.sourceFolders.length) return sql`false`;
  return and(
    eq(failures.destinationRootId, config.destinationFolderId),
    inArray(failures.sourceRootId, config.sourceFolders.map(folder => folder.id)),
    isNull(failures.resolvedAt), isNull(failures.dismissedAt), isNull(failures.retryRequestedAt),
    ...config.excludedFolders.map(folder => not(and(
      eq(failures.sourceRootId, folder.rootId),
      sql`${failures.ancestorIds} @> ${JSON.stringify([folder.id])}::jsonb`,
    )!)),
  );
}

export function syncFailureRoutes(
  fail: (req: Request, res: Response, error: unknown) => void,
  database = async () => (await import("@workspace/db")).db,
) {
  const router = Router();
  router.get("/:id/sharepoint/:target", async (req, res) => {
    const parsed = GetSyncFailureSharePointLinkParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a valid file notice and SharePoint target.", requestId: String(req.id) });
      return;
    }
    try {
      const db = await database();
      const [row] = await db.select().from(failures).where(eq(failures.id, parsed.data.id)).limit(1);
      if (!row) throw new AccessError("FailureNotFound", "The file notice could not be found.", 404);
      const folder = parsed.data.target === "folder";
      const [mapping] = await db.select({ destinationId: syncItemsTable.destinationId }).from(syncItemsTable).where(and(
        eq(syncItemsTable.destinationRootId, row.destinationRootId),
        eq(syncItemsTable.sourceRootId, String(row.sourceRootId)),
        eq(syncItemsTable.sourceId, String(folder ? row.parentId : row.sourceId)),
        eq(syncItemsTable.sourceIsFolder, folder),
      )).limit(1);
      const url = await getSyncTargetUrl(row.destinationRootId, row.path, parsed.data.target, mapping?.destinationId);
      res.json(GetSyncFailureSharePointLinkResponse.parse({ url }));
    } catch (error) { fail(req, res, error); }
  });
  router.get("/", async (req, res) => {
    const parsed = GetSyncFailuresQueryParams.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: "Invalid failure page.", requestId: String(req.id) }); return; }
    try {
      const db = await database();
      const visible = and(isNull(failures.resolvedAt), isNull(failures.dismissedAt));
      const limit = parsed.data.limit ?? 20;
      const [config] = await db.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1));
      const [total] = await db.select({ value: count() }).from(failures).where(visible);
      const [retryable] = await db.select({ value: count() }).from(failures).where(retryableScope(config));
      const rows = await db.select().from(failures).where(and(visible, gt(failures.id, parsed.data.after ?? 0)))
        .orderBy(failures.id).limit(limit + 1);
      const page = rows.slice(0, limit);
      const issueRows = page.length
        ? await db.select().from(issues).where(inArray(issues.failureId, page.map(row => row.id)))
          .orderBy(desc(issues.occurredAt), desc(issues.id))
        : [];
      const issuesByFailure = new Map<number, typeof issueRows>();
      for (const issue of issueRows) {
        const current = issuesByFailure.get(issue.failureId) ?? [];
        current.push(issue);
        issuesByFailure.set(issue.failureId, current);
      }
      res.json({ total: total.value, nextAfter: rows.length > limit ? page.at(-1)!.id : null,
        retryableCount: retryable.value, canRetryAll: config?.lastRunStatus !== "running" && retryable.value > 0,
        failures: page.map(row => {
          const fileIssues = issuesByFailure.get(row.id) ?? [];
          return {
            id: row.id, name: row.name, path: row.path, reason: row.reason,
            lastFailedAt: row.lastFailedAt.toISOString(),
            retryRequestedAt: row.retryRequestedAt?.toISOString() ?? null,
            canRetry: inScope(row, config) && !row.retryRequestedAt && config?.lastRunStatus !== "running",
            issueCount: fileIssues.length,
            latestStatus: fileIssues[0]?.status ??
              (row.reason.startsWith("Not attempted because this run stopped after an error.") ? "skipped" : "failed"),
            issues: fileIssues.slice(0, 10).map(issue => ({
              status: issue.status, reason: issue.reason, occurredAt: issue.occurredAt.toISOString(),
            })),
            ...shufflrrFailureLinks(row.portalOrigin, row.parentId, row.sourceId, row.fileHistoryId),
          };
        }) });
    } catch (error) { fail(req, res, error); }
  });
  router.post("/retry-all", async (req, res) => {
    try {
      const db = await database();
      const result = await db.transaction(async tx => {
        const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${SYNC_LOCK_ID}) AS locked`);
        if (!(lock.rows[0] as { locked?: boolean })?.locked)
          throw new AccessError("SyncRunning", "A sync is already running. Try again when it finishes.", 409);
        const [config] = await tx.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1));
        // One atomic update covers every page, without requeueing already queued or dismissed notices.
        const updated = await tx.execute(sql`
          WITH queued AS (
            UPDATE ${failures} SET retry_requested_at = now(), dismissed_at = now()
            WHERE ${retryableScope(config)}
            RETURNING id
          ) SELECT count(*)::integer AS count FROM queued`);
        // Clear even non-retryable notices (such as out-of-scope conflicts) after queuing eligible files.
        const cleared = await tx.update(failures).set({ dismissedAt: new Date() })
          .where(and(isNull(failures.resolvedAt), isNull(failures.dismissedAt)))
          .returning({ id: failures.id });
        return {
          queuedCount: Number(updated.rows[0]?.count ?? 0),
          clearedCount: Number(updated.rows[0]?.count ?? 0) + cleared.length,
          retryAt: (config?.providerRetryAt && config.providerRetryAt > new Date()
            ? config.providerRetryAt : new Date()).toISOString(),
        };
      });
      res.status(202).json(RetryAllSyncFilesResponse.parse(result));
    } catch (error) { fail(req, res, error); }
  });
  router.post("/dismiss-all", async (_req, res) => {
    try {
      const db = await database();
      const cleared = await db.update(failures).set({ dismissedAt: new Date() })
        .where(and(isNull(failures.resolvedAt), isNull(failures.dismissedAt)))
        .returning({ id: failures.id });
      res.json({ clearedCount: cleared.length });
    } catch (error) { fail(_req, res, error); }
  });
  router.put("/:id/dismiss", async (req, res) => {
    const parsed = DismissSyncFileFailureParams.safeParse(req.params);
    if (!parsed.success) { res.status(400).json({ error: "Invalid failure.", requestId: String(req.id) }); return; }
    try {
      const db = await database();
      await db.update(failures).set({ dismissedAt: new Date() }).where(eq(failures.id, parsed.data.id));
      res.status(204).end();
    } catch (error) { fail(req, res, error); }
  });
  router.post("/:id/retry", async (req, res) => {
    const parsed = RetrySyncFileParams.safeParse(req.params);
    if (!parsed.success) { res.status(400).json({ error: "Invalid failure.", requestId: String(req.id) }); return; }
    try {
      const db = await database();
      const retryAt = await db.transaction(async tx => {
        const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${SYNC_LOCK_ID}) AS locked`);
        if (!(lock.rows[0] as { locked?: boolean })?.locked)
          throw new AccessError("SyncRunning", "A sync is already running. Try again when it finishes.", 409);
        const [row] = await tx.select().from(failures).where(and(eq(failures.id, parsed.data.id), isNull(failures.resolvedAt)));
        if (!row) throw new AccessError("FailureNotFound", "This file failure has already been resolved or is unavailable.", 404);
        const [config] = await tx.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1));
        if (!inScope(row, config)) throw new AccessError("OutsideSyncScope", "This file is no longer in the saved sync scope. Adjust the folders or dismiss the notice.", 409);
        await tx.update(failures).set({ retryRequestedAt: new Date(), dismissedAt: null }).where(eq(failures.id, row.id));
        return config!.providerRetryAt && config!.providerRetryAt > new Date() ? config!.providerRetryAt : new Date();
      });
      res.status(202).json({ retryAt: retryAt.toISOString() });
    } catch (error) { fail(req, res, error); }
  });
  return router;
}
