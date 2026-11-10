import { and, eq, gt, desc, count, inArray, isNull, sql } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  DismissSyncOrphanParams,
  GetSyncConfigResponse,
  SaveSyncConfigBody,
  SetSyncEnabledBody,
  SetSyncIntervalBody,
  GetSyncRunsResponse,
  GetSyncRunEventsQueryParams,
  GetSyncRunEventsResponse,
  type SyncConfigInput,
} from "@workspace/api-zod";
import {
  syncConfigTable,
  syncItemsTable,
  syncOrphanNoticesTable,
  syncRunsTable,
  syncRunEventsTable,
  type SyncSourceFolder,
  type SyncFolderExclusion,
} from "@workspace/db/schema";
import { ShufflrrError } from "@workspace/shufflrr";
import { newShufflrrClient, shufflrrConfig } from "../lib/shufflrr";
import { AccessError, getSyncDriveItem } from "../lib/sharepoint";
import { SYNC_LOCK_ID } from "../lib/sync-runner";
import { ProviderBackoffError } from "@workspace/shufflrr/http-policy";
import { exclusionNoticeKey, validateFolderExclusions } from "../lib/sync-exclusions";
import { syncFailureRoutes } from "./sync-failures";

const router: IRouter = Router();

router.use("/sync", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.removeHeader("Access-Control-Allow-Origin");
  const origin = req.get("origin");
  try {
    if (req.get("sec-fetch-site") === "cross-site" ||
      (origin && new URL(origin).host !== req.get("host") && new URL(origin).host !== req.get("x-forwarded-host"))) {
      res.status(403).json({ error: "Cross-origin access is not allowed.", requestId: String(req.id) });
      return;
    }
  } catch {
    res.status(403).json({ error: "Invalid request origin.", requestId: String(req.id) });
    return;
  }
  const { isAuthenticated, userId } = getAuth(req);
  if (!isAuthenticated || !userId) {
    res.status(401).json({ error: "Sign in to manage sync.", requestId: String(req.id) });
    return;
  }
  next();
});

router.use("/sync/failures", syncFailureRoutes(operationError));

function emptyConfig() {
  return {
    configured: false,
    destinationFolderId: null,
    destinationFolderName: null,
    sourceFolders: [],
    excludedFolders: [],
    enabled: false,
    pollIntervalSeconds: 60,
    nextRunAt: null,
    providerCooldownUntil: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    lastRunConflicts: [],
    lastRunError: null,
    detachedPairs: [],
  };
}

async function responseConfig() {
  const { db } = await import("@workspace/db");
  const [config] = await db.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1);
  const detachedPairs = await db.select({
    id: syncOrphanNoticesTable.id,
    sourceRootName: syncOrphanNoticesTable.sourceRootName,
    destinationFolderName: syncOrphanNoticesTable.destinationFolderName,
    createdAt: syncOrphanNoticesTable.createdAt,
  }).from(syncOrphanNoticesTable)
    .where(isNull(syncOrphanNoticesTable.dismissedAt))
    .orderBy(syncOrphanNoticesTable.createdAt);

  if (!config) return GetSyncConfigResponse.parse({ ...emptyConfig(), detachedPairs });
  const value = {
    configured: !!config.destinationFolderId && config.sourceFolders.length > 0,
    destinationFolderId: config.destinationFolderId,
    destinationFolderName: config.destinationFolderName,
    sourceFolders: config.sourceFolders,
    excludedFolders: config.excludedFolders,
    enabled: config.enabled,
    pollIntervalSeconds: config.pollIntervalSeconds,
    nextRunAt: config.nextRunAt,
    providerCooldownUntil: config.providerRetryAt && config.providerRetryAt.getTime() > Date.now()
      ? config.providerRetryAt : null,
    lastRunAt: config.lastRunAt,
    lastRunStatus: config.lastRunStatus,
    lastRunSummary: config.lastRunSummary,
    lastRunConflicts: config.lastRunConflicts,
    lastRunError: config.lastRunError,
    detachedPairs,
  };
  return GetSyncConfigResponse.parse(value);
}

function operationError(req: Request, res: Response, error: unknown): void {
  if (error instanceof ProviderBackoffError || (error instanceof ShufflrrError && error.code === "throttled")) {
    res.set("Retry-After", String(Math.max(1, Math.ceil(((error.retryAt?.getTime() ?? Date.now() + 1000) - Date.now()) / 1000))));
    res.status(503).json({ error: "The provider has requested a pause. Try again after its cooldown.", requestId: String(req.id) });
    return;
  }
  req.log.error({
    event: "sync_configuration_failure",
    code: error instanceof ShufflrrError || error instanceof AccessError ? error.code : "unexpected",
  }, "Sync configuration request failed.");
  if (error instanceof ShufflrrError) {
    const status = error.code === "permission" ? 403 : error.code === "configuration" ? 503 : 400;
    res.status(status).json({ error: error.message, requestId: String(req.id) });
    return;
  }
  if (error instanceof AccessError) {
    const status = [400, 401, 403, 404, 409].includes(error.status) ? error.status : 502;
    res.status(status).json({ error: error.message, requestId: String(req.id) });
    return;
  }
  res.status(503).json({
    error: "Sync storage is unavailable. Check the database connection and apply the database migration.",
    requestId: String(req.id),
  });
}

router.get("/sync/config", async (req, res): Promise<void> => {
  try {
    res.json(await responseConfig());
  } catch (error) {
    operationError(req, res, error);
  }
});

router.get("/sync/runs", async (req, res): Promise<void> => {
  try {
    const { db } = await import("@workspace/db");
    const runs = await db.select().from(syncRunsTable)
      .orderBy(desc(syncRunsTable.startedAt), desc(syncRunsTable.id)).limit(50);
    res.json(GetSyncRunsResponse.parse(runs));
  } catch (error) { operationError(req, res, error); }
});

router.get("/sync/events", async (req, res): Promise<void> => {
  const parsed = GetSyncRunEventsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a valid sync run and status.", requestId: String(req.id) });
    return;
  }
  try {
    const { db } = await import("@workspace/db");
    const { runId, status, after, limit = 100 } = parsed.data;
    const [run] = await db.select({ id: syncRunsTable.id }).from(syncRunsTable)
      .where(eq(syncRunsTable.id, runId)).limit(1);
    if (!run) {
      res.status(404).json({ error: "Sync run not found. Older run logs may have expired.", requestId: String(req.id) });
      return;
    }
    const events = await db.select().from(syncRunEventsTable).where(and(
      eq(syncRunEventsTable.runId, runId),
      status ? eq(syncRunEventsTable.status, status) : undefined,
      after === undefined ? undefined : gt(syncRunEventsTable.id, after),
    )).orderBy(syncRunEventsTable.id).limit(limit + 1);
    const counts = await db.select({ status: syncRunEventsTable.status, count: count() })
      .from(syncRunEventsTable).where(eq(syncRunEventsTable.runId, runId)).groupBy(syncRunEventsTable.status);
    const hasMore = events.length > limit;
    const page = events.slice(0, limit);
    res.json(GetSyncRunEventsResponse.parse({
      events: page, counts,
      nextAfter: hasMore ? page.at(-1)!.id : null,
    }));
  } catch (error) { operationError(req, res, error); }
});

router.put("/sync/config", async (req, res): Promise<void> => {
  const parsed = SaveSyncConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a SharePoint destination and at least one Shufflrr folder.", requestId: String(req.id) });
    return;
  }
  const selectedIds = parsed.data.sourceFolders.map(folder => folder.id);
  if (new Set(selectedIds).size !== selectedIds.length) {
    res.status(400).json({ error: "Select each Shufflrr folder only once.", requestId: String(req.id) });
    return;
  }
  try {
    const { db } = await import("@workspace/db");

    const destinationId = parsed.data.destinationFolderId;
    const destination = await getSyncDriveItem(destinationId);
    if (!destination.isFolder) {
      res.status(400).json({ error: "Choose a SharePoint folder.", requestId: String(req.id) });
      return;
    }

    const shufflrr = newShufflrrClient();
    const [storedScope] = await db.select({ excludedFolders: syncConfigTable.excludedFolders })
      .from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1);
    let sourceFolders: SyncSourceFolder[];
    let excludedFolders: SyncFolderExclusion[];
    try {
      const credentials = shufflrrConfig();
      await shufflrr.login(credentials.email, credentials.password);
      sourceFolders = await Promise.all(parsed.data.sourceFolders.map(async folder => {
        const currentFolder = await shufflrr.folder(folder.id);
        return { id: currentFolder.id, name: currentFolder.name };
      }));
      excludedFolders = await validateFolderExclusions(shufflrr, sourceFolders, parsed.data.excludedFolders,
        storedScope?.excludedFolders ?? []);
    } finally {
      await shufflrr.close();
    }

    const input: SyncConfigInput = {
      destinationFolderId: destinationId,
      destinationFolderName: destination.name || "Shared Documents",
      sourceFolders,
      excludedFolders,
      pollIntervalSeconds: parsed.data.pollIntervalSeconds ?? 60,
    };
    await db.transaction(async tx => {
      const lockResult = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${SYNC_LOCK_ID}) AS locked`);
      const locked = (lockResult.rows[0] as { locked?: boolean } | undefined)?.locked === true;
      if (!locked) throw new AccessError("SyncRunning", "Wait for the current sync run to finish before changing its folders.", 409);

      const [current] = await tx.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1);
      if (current?.enabled) {
        throw new AccessError("SyncEnabled", "Pause sync before changing its folders.", 409);
      }

      const oldRoots = current?.sourceFolders ?? [];
      const oldDestinationId = current?.destinationFolderId;
      const oldDestinationName = current?.destinationFolderName;
      if (oldDestinationId && oldDestinationName) {
        const newRootIds = new Set(sourceFolders.map(folder => String(folder.id)));
        const destinationChanged = oldDestinationId !== destinationId;
        const rootMappings = oldRoots.length
          ? await tx.select({ sourceRootId: syncItemsTable.sourceRootId }).from(syncItemsTable).where(and(
              eq(syncItemsTable.destinationRootId, oldDestinationId),
              inArray(syncItemsTable.sourceRootId, oldRoots.map(folder => String(folder.id))),
              eq(syncItemsTable.sourceIsFolder, true),
              isNull(syncItemsTable.sourceParentId),
            ))
          : [];
        const mappedRootIds = new Set(rootMappings.map(item => item.sourceRootId));
        const activeNotices = await tx.select({
          sourceRootId: syncOrphanNoticesTable.sourceRootId,
          destinationFolderId: syncOrphanNoticesTable.destinationFolderId,
        }).from(syncOrphanNoticesTable).where(isNull(syncOrphanNoticesTable.dismissedAt));
        const activeNoticePairs = new Set(activeNotices.map(item =>
          `${item.sourceRootId}:${item.destinationFolderId}`,
        ));
        const detached = oldRoots.filter(folder =>
          (destinationChanged || !newRootIds.has(String(folder.id))) &&
          mappedRootIds.has(String(folder.id)) &&
          !activeNoticePairs.has(`${folder.id}:${oldDestinationId}`),
        );
        if (detached.length) {
          await tx.insert(syncOrphanNoticesTable).values(detached.map(folder => ({
            sourceRootId: String(folder.id),
            sourceRootName: folder.name,
            destinationFolderId: oldDestinationId,
            destinationFolderName: oldDestinationName,
          })));
        }
      }

      if (current?.destinationFolderId === destinationId) {
        const previousKeys = new Set(current.excludedFolders.map(exclusionNoticeKey));
        const newKeys = new Set(excludedFolders.map(exclusionNoticeKey));
        const restored = current.excludedFolders.filter(folder => !newKeys.has(exclusionNoticeKey(folder)));
        if (restored.length) await tx.update(syncOrphanNoticesTable).set({ dismissedAt: new Date() })
          .where(and(eq(syncOrphanNoticesTable.destinationFolderId, destinationId),
            inArray(syncOrphanNoticesTable.sourceRootId, restored.map(exclusionNoticeKey))));
        const newlyExcluded = excludedFolders.filter(folder => !previousKeys.has(exclusionNoticeKey(folder)));
        if (newlyExcluded.length) {
          const mappings = await tx.select().from(syncItemsTable)
            .where(eq(syncItemsTable.destinationRootId, destinationId));
          const notices = newlyExcluded.flatMap(folder => {
            const mapping = mappings.find(item => item.sourceIsFolder &&
              item.sourceRootId === String(folder.rootId) && item.sourceId === String(folder.id));
            return mapping ? [{
              sourceRootId: exclusionNoticeKey(folder), sourceRootName: mapping.relativePath,
              destinationFolderId: destinationId,
              destinationFolderName: `${input.destinationFolderName}/${mapping.relativePath}`,
            }] : [];
          });
          if (notices.length) await tx.insert(syncOrphanNoticesTable).values(notices);
        }
      }

      await tx.insert(syncConfigTable).values({
        id: 1,
        ...input,
        enabled: false,
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunSummary: null,
        lastRunConflicts: [],
        lastRunError: null,
      }).onConflictDoUpdate({
        target: syncConfigTable.id,
        set: {
          ...input,
          enabled: false,
          nextRunAt: sql`${syncConfigTable.providerRetryAt}`,
          updatedAt: new Date(),
          lastRunAt: null,
          lastRunStatus: null,
          lastRunSummary: null,
          lastRunConflicts: [],
          lastRunError: null,
        },
      });
    });
    res.json(await responseConfig());
  } catch (error) {
    operationError(req, res, error);
  }
});

router.put("/sync/interval", async (req, res): Promise<void> => {
  const parsed = SetSyncIntervalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a supported polling interval.", requestId: String(req.id) });
    return;
  }
  try {
    const { db } = await import("@workspace/db");
    await db.insert(syncConfigTable).values({ id: 1, pollIntervalSeconds: parsed.data.pollIntervalSeconds })
      .onConflictDoUpdate({
        target: syncConfigTable.id,
        // Preserve a provider cooldown, even when a user chooses a shorter interval.
        set: {
          pollIntervalSeconds: parsed.data.pollIntervalSeconds,
          nextRunAt: sql`greatest(now(), coalesce(${syncConfigTable.lastRunAt}, now()) + ${parsed.data.pollIntervalSeconds} * interval '1 second', coalesce(${syncConfigTable.providerRetryAt}, now()))`,
          updatedAt: new Date(),
        },
      });
    res.json(await responseConfig());
  } catch (error) {
    operationError(req, res, error);
  }
});

router.put("/sync/enabled", async (req, res): Promise<void> => {
  const parsed = SetSyncEnabledBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose whether sync should be enabled.", requestId: String(req.id) });
    return;
  }
  try {
    const { db } = await import("@workspace/db");
    await db.transaction(async tx => {
      const lockResult = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${SYNC_LOCK_ID}) AS locked`);
      const locked = (lockResult.rows[0] as { locked?: boolean } | undefined)?.locked === true;
      if (!locked) throw new AccessError("SyncRunning", "Wait for the current sync run to finish before changing sync state.", 409);

      const [config] = await tx.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1);
      if (parsed.data.enabled && (!config?.destinationFolderId || !config.sourceFolders.length)) {
        throw new AccessError("SyncNotConfigured", "Save a SharePoint destination and Shufflrr folders before enabling sync.", 400);
      }
      await tx.insert(syncConfigTable).values({ id: 1, enabled: parsed.data.enabled })
        .onConflictDoUpdate({ target: syncConfigTable.id, set: {
          enabled: parsed.data.enabled,
          // An enable transition is due now, never one polling interval from now.
          // Repeating an enable request must not bypass the existing schedule.
          nextRunAt: parsed.data.enabled && !config?.enabled
            ? sql`greatest(now(), coalesce(${syncConfigTable.providerRetryAt}, now()))`
            : config?.nextRunAt ?? null,
          updatedAt: new Date(),
        } });
    });
    res.json(await responseConfig());
  } catch (error) {
    operationError(req, res, error);
  }
});

router.delete("/sync/orphans/:id", async (req, res): Promise<void> => {
  const parsed = DismissSyncOrphanParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid sync notice.", requestId: String(req.id) });
    return;
  }
  try {
    const { db } = await import("@workspace/db");
    const [dismissed] = await db.update(syncOrphanNoticesTable)
      .set({ dismissedAt: new Date() })
      .where(and(
        eq(syncOrphanNoticesTable.id, parsed.data.id),
        isNull(syncOrphanNoticesTable.dismissedAt),
      ))
      .returning({ id: syncOrphanNoticesTable.id });
    if (!dismissed) {
      res.status(404).json({ error: "Sync notice not found.", requestId: String(req.id) });
      return;
    }
    res.sendStatus(204);
  } catch (error) {
    operationError(req, res, error);
  }
});

export default router;
