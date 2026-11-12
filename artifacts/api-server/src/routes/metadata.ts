import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import {
  GetMetadataStatusResponse, GetMetadataEventsQueryParams, GetMetadataEventsResponse,
  GetFileMetadataQueryParams, GetFileMetadataResponse, RequestMetadataRefreshResponse,
} from "@workspace/api-zod";
import { fileMetadataTable, metadataControlTable, metadataRunsTable, metadataEventsTable } from "@workspace/db/schema";
import { loadMetadataScope } from "../lib/metadata-scope";
import { metadataIntervalSeconds } from "../lib/metadata-policy";
import { requestMetadataRefresh } from "../lib/metadata-store";
import { syncDriveId } from "../lib/sharepoint";
import { shufflrrConfig } from "../lib/shufflrr";

function unavailable(req: Request, res: Response) {
  req.log.error({ event: "metadata_request_failed" }, "Metadata storage request failed.");
  res.status(503).json({ error: "Metadata is unavailable. Check the metadata worker and database migration.", requestId: String(req.id) });
}

/** Mounted beneath the existing /sync authentication and same-origin guards. */
export function metadataRoutes(): IRouter {
  const router = Router();
  router.get("/status", async (req, res): Promise<void> => {
    try {
      const { db } = await import("@workspace/db");
      const scope = await loadMetadataScope(db);
      const [control] = await db.select().from(metadataControlTable).where(eq(metadataControlTable.id, 1)).limit(1);
      const runs = scope ? await db.select().from(metadataRunsTable).where(eq(metadataRunsTable.scopeKey, scope.key))
        .orderBy(desc(metadataRunsTable.startedAt)).limit(50) : [];
      const pending = !!(control?.requestedAt &&
        (!control.handledAt || control.requestedAt > control.handledAt));
      res.json(GetMetadataStatusResponse.parse({
        configured: !!scope, pending: !!scope && pending, workerLastSeenAt: control?.workerLastSeenAt ?? null,
        nextCrawlAt: scope ? control?.retryAt && control.retryAt > new Date() ? control.retryAt : control?.nextCrawlAt ?? null : null,
        intervalSeconds: metadataIntervalSeconds(), runs,
      }));
    } catch { unavailable(req, res); }
  });
  router.post("/refresh", async (req, res): Promise<void> => {
    try {
      const { db } = await import("@workspace/db");
      if (!await loadMetadataScope(db)) {
        res.status(400).json({ error: "Configure sync folders before refreshing metadata.", requestId: String(req.id) }); return;
      }
      res.status(202).json(RequestMetadataRefreshResponse.parse({ requestedAt: await requestMetadataRefresh(db) }));
    } catch { unavailable(req, res); }
  });
  router.get("/events", async (req, res): Promise<void> => {
    const query = GetMetadataEventsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Choose a valid metadata run and page.", requestId: String(req.id) }); return;
    }
    try {
      const { db } = await import("@workspace/db");
      const scope = await loadMetadataScope(db);
      const [run] = scope ? await db.select().from(metadataRunsTable).where(and(
        eq(metadataRunsTable.id, query.data.runId), eq(metadataRunsTable.scopeKey, scope.key),
      )).limit(1) : [];
      if (!run) { res.status(404).json({ error: "Metadata run not found in this sync scope.", requestId: String(req.id) }); return; }
      const limit = query.data.limit ?? 50;
      const events = await db.select().from(metadataEventsTable).where(and(
        eq(metadataEventsTable.runId, run.id),
        query.data.after === undefined ? undefined : gt(metadataEventsTable.id, query.data.after),
      )).orderBy(metadataEventsTable.id).limit(limit + 1);
      const page = events.slice(0, limit);
      res.json(GetMetadataEventsResponse.parse({ events: page, nextAfter: events.length > limit ? page.at(-1)!.id : null }));
    } catch { unavailable(req, res); }
  });
  router.get("/file", async (req, res): Promise<void> => {
    const query = GetFileMetadataQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Enter a valid SharePoint drive ID and item ID.", requestId: String(req.id) }); return;
    }
    try {
      const { db } = await import("@workspace/db");
      const scope = await loadMetadataScope(db);
      // The caller cannot select another drive, portal, or organization's records.
      if (!scope || query.data.driveId !== await syncDriveId()) {
        res.status(404).json({ error: "Metadata not found in this sync scope.", requestId: String(req.id) }); return;
      }
      const records = await db.select().from(fileMetadataTable).where(and(
        eq(fileMetadataTable.driveId, query.data.driveId), eq(fileMetadataTable.itemId, query.data.itemId),
        eq(fileMetadataTable.sourcePortal, new URL(shufflrrConfig().baseUrl).origin),
        eq(fileMetadataTable.destinationRootId, scope.config.destinationFolderId!),
        inArray(fileMetadataTable.sourceRootId, scope.config.sourceFolders.map(folder => String(folder.id))),
      )).orderBy(desc(fileMetadataTable.lastAttemptAt)).limit(100);
      const isMapped = (record: typeof fileMetadataTable.$inferSelect) => scope.mappings.some(mapping =>
        mapping.destinationId === record.itemId && Number(mapping.sourceId) === record.sourceFileId &&
        mapping.sourceRootId === record.sourceRootId);
      const record = records.find(isMapped) ?? records[0];
      if (!record) {
        res.status(404).json({ error: "No metadata has been captured for this SharePoint file.", requestId: String(req.id) }); return;
      }
      const mapped = isMapped(record);
      const [latestRun] = await db.select().from(metadataRunsTable).where(eq(metadataRunsTable.scopeKey, scope.key))
        .orderBy(desc(metadataRunsTable.startedAt)).limit(1);
      const failedAfterObservation = latestRun?.status === "failed" &&
        (!record.observedAt || latestRun.startedAt > record.observedAt);
      res.json(GetFileMetadataResponse.parse({
        ...record, mapped, stale: !mapped || !!record.lastError || !!failedAfterObservation || !record.observedAt ||
          Date.now() - record.observedAt.getTime() > metadataIntervalSeconds() * 2000,
      }));
    } catch { unavailable(req, res); }
  });
  return router;
}
