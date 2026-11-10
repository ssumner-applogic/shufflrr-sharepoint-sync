import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { syncConfigTable, syncFileFailuresTable as failures } from "@workspace/db/schema";
import { GetSyncFailuresQueryParams, DismissSyncFileFailureParams, RetrySyncFileParams } from "@workspace/api-zod";
import { shufflrrFailureLinks } from "../lib/sync-file-failures";
import { SYNC_LOCK_ID } from "../lib/sync-runner";
import { AccessError } from "../lib/sharepoint";

function inScope(row: typeof failures.$inferSelect, config: typeof syncConfigTable.$inferSelect | undefined) {
  return !!config && config.destinationFolderId === row.destinationRootId &&
    config.sourceFolders.some(folder => folder.id === row.sourceRootId) &&
    !config.excludedFolders.some(folder => folder.rootId === row.sourceRootId && row.ancestorIds.includes(folder.id));
}

export function syncFailureRoutes(fail: (req: Request, res: Response, error: unknown) => void) {
  const router = Router();
  router.get("/", async (req, res) => {
    const parsed = GetSyncFailuresQueryParams.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: "Invalid failure page.", requestId: String(req.id) }); return; }
    try {
      const { db } = await import("@workspace/db");
      const visible = and(isNull(failures.resolvedAt), isNull(failures.dismissedAt));
      const limit = parsed.data.limit ?? 20;
      const [config] = await db.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1));
      const [total] = await db.select({ value: count() }).from(failures).where(visible);
      const rows = await db.select().from(failures).where(and(visible, gt(failures.id, parsed.data.after ?? 0)))
        .orderBy(failures.id).limit(limit + 1);
      const page = rows.slice(0, limit);
      res.json({ total: total.value, nextAfter: rows.length > limit ? page.at(-1)!.id : null,
        failures: page.map(row => ({
          id: row.id, name: row.name, path: row.path, reason: row.reason,
          lastFailedAt: row.lastFailedAt.toISOString(),
          retryRequestedAt: row.retryRequestedAt?.toISOString() ?? null,
          canRetry: inScope(row, config) && !row.retryRequestedAt && config?.lastRunStatus !== "running",
          ...shufflrrFailureLinks(row.portalOrigin, row.parentId, row.sourceId, row.fileHistoryId),
        })) });
    } catch (error) { fail(req, res, error); }
  });
  router.put("/:id/dismiss", async (req, res) => {
    const parsed = DismissSyncFileFailureParams.safeParse(req.params);
    if (!parsed.success) { res.status(400).json({ error: "Invalid failure.", requestId: String(req.id) }); return; }
    try {
      const { db } = await import("@workspace/db");
      await db.update(failures).set({ dismissedAt: new Date() }).where(eq(failures.id, parsed.data.id));
      res.status(204).end();
    } catch (error) { fail(req, res, error); }
  });
  router.post("/:id/retry", async (req, res) => {
    const parsed = RetrySyncFileParams.safeParse(req.params);
    if (!parsed.success) { res.status(400).json({ error: "Invalid failure.", requestId: String(req.id) }); return; }
    try {
      const { db } = await import("@workspace/db");
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
