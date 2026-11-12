import { Router, type Request, type Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  syncConfigTable, syncFileFailuresTable as failures, syncFileRulesTable as rules, syncItemsTable,
} from "@workspace/db/schema";
import { ResolveSyncConflictsBody, ReenableSyncFilesBody, GetSyncIgnoredFilesResponse } from "@workspace/api-zod";
import { AccessError, getSyncPathItem } from "../lib/sharepoint";
import { SYNC_LOCK_ID } from "../lib/sync-runner";
import { fileInRuleScope } from "../lib/sync-file-rules";
import { shufflrrFailureLinks } from "../lib/sync-file-failures";

type Database = typeof import("@workspace/db")["db"];
async function lock(tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) {
  const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${SYNC_LOCK_ID}) AS locked`);
  if ((result.rows[0] as { locked?: boolean })?.locked !== true)
    throw new AccessError("SyncRunning", "Wait for the active run to finish before changing file rules.", 409);
}
export function syncResolutionRoutes(fail: (req: Request, res: Response, error: unknown) => void) {
  const router = Router();
  router.post("/resolutions", async (req, res) => {
    const parsed = ResolveSyncConflictsBody.safeParse(req.body);
    if (!parsed.success || new Set(parsed.data.failureIds).size !== parsed.data.failureIds.length) {
      res.status(400).json({ error: "Choose up to 100 distinct files and an overwrite or ignore action.", requestId: String(req.id) }); return;
    }
    try {
      const { db } = await import("@workspace/db");
      await db.transaction(async tx => {
        await lock(tx);
        const [config] = await tx.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1).for("update");
        const rows = await tx.select().from(failures).where(inArray(failures.id, parsed.data.failureIds));
        if (rows.length !== parsed.data.failureIds.length || rows.some(row => row.resolvedAt || !fileInRuleScope(row, config)))
          throw new AccessError("InvalidRuleScope", "A selected file is no longer in the current sync scope. Refresh and review the selection.", 409);
        for (const row of rows) {
          let destinationId: string | null = null;
          let eTag: string | null = null;
          if (parsed.data.action === "overwrite") {
            if (!row.reason.startsWith("An existing SharePoint item") && !row.reason.startsWith("SharePoint changed since"))
              throw new AccessError("NotAConflict", "Overwrite is available only for destination path conflicts.", 400);
            const item = await getSyncPathItem(row.destinationRootId, row.path);
            if (item.isFolder || !item.eTag)
              throw new AccessError("UnsafeOverwrite", "The destination is not a file with a verifiable version. It was left unchanged.", 409);
            const owners = await tx.select().from(syncItemsTable).where(and(
              eq(syncItemsTable.destinationRootId, row.destinationRootId), eq(syncItemsTable.destinationId, item.id)));
            if (owners.some(owner => owner.sourceRootId !== String(row.sourceRootId) || owner.sourceId !== String(row.sourceId)))
              throw new AccessError("AlreadyManaged", "This SharePoint item belongs to another sync pairing. Resolve the folder-name collision first.", 409);
            destinationId = item.id; eTag = item.eTag;
          }
          const value = { failureId: row.id, sourceId: row.sourceId, sourceRootId: row.sourceRootId,
            destinationRootId: row.destinationRootId, destinationRootName: config!.destinationFolderName!,
            action: parsed.data.action, expectedDestinationId: destinationId, expectedETag: eTag };
          await tx.insert(rules).values(value).onConflictDoUpdate({
            target: [rules.sourceId, rules.sourceRootId, rules.destinationRootId], set: { ...value, createdAt: new Date() },
          });
          await tx.update(failures).set({ retryRequestedAt: null, dismissedAt: null }).where(eq(failures.id, row.id));
        }
      });
      req.log.info({ event: "sync_file_resolution", action: parsed.data.action, count: parsed.data.failureIds.length }, "File resolution choices saved; no files changed.");
      res.status(204).end();
    } catch (error) { fail(req, res, error); }
  });
  router.get("/ignored", async (req, res) => {
    try {
      const { db } = await import("@workspace/db");
      const [config] = await db.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1));
      const rows = await db.select({ rule: rules, file: failures }).from(rules)
        .innerJoin(failures, eq(failures.id, rules.failureId)).where(eq(rules.action, "ignore")).orderBy(rules.id).limit(1001);
      if (rows.length > 1000) throw new AccessError("RuleLimit", "Too many ignore rules to display. Ask an operator to review the rule limit.", 400);
      res.json(GetSyncIgnoredFilesResponse.parse(rows.map(({ rule, file }) => ({
        id: rule.id, failureId: file.id, name: file.name, path: file.path,
        destinationFolderName: rule.destinationRootName, createdAt: rule.createdAt,
        active: fileInRuleScope(file, config),
        ...shufflrrFailureLinks(file.portalOrigin, file.parentId, file.sourceId, file.fileHistoryId),
      }))));
    } catch (error) { fail(req, res, error); }
  });
  router.post("/ignored/reenable", async (req, res) => {
    const parsed = ReenableSyncFilesBody.safeParse(req.body);
    if (!parsed.success || new Set(parsed.data.ruleIds).size !== parsed.data.ruleIds.length) {
      res.status(400).json({ error: "Choose up to 100 distinct ignore rules.", requestId: String(req.id) }); return;
    }
    try {
      const { db } = await import("@workspace/db");
      await db.transaction(async tx => {
        await lock(tx);
        const rows = await tx.select().from(rules).where(and(inArray(rules.id, parsed.data.ruleIds), eq(rules.action, "ignore")));
        if (rows.length !== parsed.data.ruleIds.length) throw new AccessError("RuleChanged", "An ignore rule changed. Refresh and try again.", 409);
        await tx.delete(rules).where(inArray(rules.id, rows.map(row => row.id)));
        await tx.update(failures).set({ dismissedAt: null, resolvedAt: null, retryRequestedAt: null })
          .where(inArray(failures.id, rows.map(row => row.failureId)));
      });
      res.status(204).end();
    } catch (error) { fail(req, res, error); }
  });
  return router;
}
