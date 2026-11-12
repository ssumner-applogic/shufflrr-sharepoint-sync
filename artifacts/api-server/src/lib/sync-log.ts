import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { SyncFileFailureStore } from "./sync-file-failures";
import {
  syncRunsTable, syncRunEventsTable, syncConfigTable,
  type SyncLogEventInput, type SyncRunSummary, type SyncConflict,
} from "@workspace/db/schema";

export interface SyncReporter {
  record(event: SyncLogEventInput): Promise<void>;
  progress(summary: SyncRunSummary, conflicts: SyncConflict[]): void;
  flush?(): Promise<void>;
}

/** Shared by the HTTP server and private worker; file paths stay in protected storage, not stdout. */
export class SyncRunJournal implements SyncReporter {
  fileFailures?: SyncFileFailureStore;
  private pending: Array<typeof syncRunEventsTable.$inferInsert> = [];
  private lastFlush = 0;
  summary: SyncRunSummary | null = null;
  conflicts: SyncConflict[] = [];
  hasFailure = false;
  constructor(private db: typeof import("@workspace/db")["db"], readonly runId: string) {}

  async start() {
    // Preserve the pre-upgrade last-known conflicts before the new run replaces the status banner.
    // Do not invent successful file paths that the old implementation never recorded.
    const [anyRun] = await this.db.select({ id: syncRunsTable.id }).from(syncRunsTable).limit(1);
    if (!anyRun) {
      const [previous] = await this.db.select().from(syncConfigTable).where(eq(syncConfigTable.id, 1)).limit(1);
      if (previous?.lastRunAt && ["success", "partial", "failed"].includes(previous.lastRunStatus ?? "")) {
        const oldRunId = randomUUID();
        const previousRunAt = previous.lastRunAt;
        await this.db.transaction(async tx => {
          await tx.insert(syncRunsTable).values({
            id: oldRunId, startedAt: previousRunAt, finishedAt: previousRunAt,
            status: previous.lastRunStatus!, summary: previous.lastRunSummary, error: previous.lastRunError,
          });
          await tx.insert(syncRunEventsTable).values([{
            runId: oldRunId, status: "skipped", itemType: "run",
            path: null, destinationPath: null, occurredAt: previousRunAt,
            message: "Historical result imported before detailed logging existed. Only saved conflicts and summary counts are available; other per-file outcomes were not recorded.",
          }, ...previous.lastRunConflicts.map(conflict => ({
            runId: oldRunId, status: "conflict" as const, itemType: "run" as const,
            path: conflict.kind === "path-conflict" ? conflict.path : null,
            destinationPath: `${previous.destinationFolderName ?? ""}/${conflict.path}`,
            occurredAt: previousRunAt,
            message: conflict.kind === "path-conflict"
              ? "Previously recorded conflict: an existing SharePoint item was left unchanged."
              : "Previously recorded conflict: a SharePoint-only item was left untouched.",
          }))]);
        });
      }
    }
    // The caller holds the sync advisory lock, so any previous running entry was interrupted.
    await this.db.update(syncRunsTable).set({
      status: "failed", finishedAt: new Date(),
      error: "This run was interrupted before completion. Its recorded outcomes are shown below.",
    }).where(eq(syncRunsTable.status, "running"));
    await this.db.insert(syncRunsTable).values({ id: this.runId });
    // Only log metadata is pruned; never sync settings, mappings, or provider content.
    await this.db.execute(sql`DELETE FROM sync_runs WHERE id NOT IN
      (SELECT id FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 50)`);
  }

  progress(summary: SyncRunSummary, conflicts: SyncConflict[]) {
    this.summary = summary;
    this.conflicts = conflicts;
  }

  async record(event: SyncLogEventInput) {
    this.hasFailure ||= event.status === "failed";
    const { sourceFile, ...logEvent } = event;
    if (sourceFile && event.path) {
      // Skipped enumerated files also need an actionable notice (e.g. a blocked parent or earlier failure).
      // Intentionally excluded copies have no sourceFile metadata and never enter this branch.
      if (event.status === "failed" || event.status === "conflict" || event.status === "skipped")
        await this.fileFailures?.fail(sourceFile, event.path, event.message, event.status, this.runId);
      else if (["copied", "updated", "unchanged", "moved"].includes(event.status))
        await this.fileFailures?.resolve(sourceFile);
    }
    this.pending.push({ ...logEvent, runId: this.runId, occurredAt: new Date() });
    if (this.pending.length >= 25 || Date.now() - this.lastFlush >= 1000 ||
      event.status === "failed" || event.status === "conflict") await this.flush();
  }

  async flush() {
    if (!this.pending.length && !this.summary?.inventory && !this.summary?.fileProgress) return;
    if (this.pending.length) {
      const batch = this.pending;
      await this.db.insert(syncRunEventsTable).values(batch);
      this.pending = [];
    }
    if (this.summary?.inventory || this.summary?.fileProgress) {
      await this.db.update(syncRunsTable).set({ summary: this.summary })
        .where(eq(syncRunsTable.id, this.runId));
    }
    this.lastFlush = Date.now();
  }

  async finish(status: "success" | "partial" | "failed", error: string | null) {
    await this.flush();
    await this.db.update(syncRunsTable).set({
      status, error, summary: this.summary, finishedAt: new Date(),
    }).where(eq(syncRunsTable.id, this.runId));
  }
}
