import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  syncFileFailuresTable as failures,
  syncFileFailureIssuesTable as issues,
  type SyncFileIssueStatus,
  type SyncFileReference,
} from "@workspace/db/schema";

export class SyncFileFailureStore {
  private unresolvedKeys?: Set<string>;
  constructor(private db: typeof import("@workspace/db")["db"], private destinationRootId: string,
    private portalOrigin: string) {}
  async fail(file: SyncFileReference, path: string, reason: string, status: SyncFileIssueStatus, runId: string) {
    const fingerprint = createHash("sha256").update(JSON.stringify([
      file.modifiedAt, file.size, file.parentId, path, reason,
    ])).digest("hex");
    const value = { sourceId: file.id, sourceRootId: file.rootId, parentId: file.parentId,
      ancestorIds: file.ancestorIds, destinationRootId: this.destinationRootId,
      portalOrigin: this.portalOrigin, fileHistoryId: file.fileHistoryId ?? null,
      name: file.name, path, reason, fingerprint };
    const [failure] = await this.db.insert(failures).values(value).onConflictDoUpdate({
      target: [failures.sourceId, failures.sourceRootId, failures.destinationRootId],
      set: { ...value, lastFailedAt: new Date(), resolvedAt: null,
        dismissedAt: sql`case when ${failures.fingerprint} = ${fingerprint} and ${failures.reason} = ${reason} and ${failures.resolvedAt} is null
          then ${failures.dismissedAt} else null end` },
    }).returning({ id: failures.id });
    if (!failure) throw new Error("Could not persist the file failure.");
    await this.db.insert(issues).values({ failureId: failure.id, runId, status, reason });
    this.unresolvedKeys?.add(`${file.rootId}:${file.id}`);
  }
  async resolve(file: SyncFileReference) {
    if (!this.unresolvedKeys) {
      const rows = await this.db.select({ rootId: failures.sourceRootId, id: failures.sourceId })
        .from(failures).where(and(eq(failures.destinationRootId, this.destinationRootId), isNull(failures.resolvedAt)))
        .limit(100_001);
      if (rows.length > 100_000) throw new Error("The unresolved file-failure safety limit was reached.");
      this.unresolvedKeys = new Set(rows.map(row => `${row.rootId}:${row.id}`));
    }
    const key = `${file.rootId}:${file.id}`;
    if (!this.unresolvedKeys.has(key)) return;
    await this.db.update(failures).set({ resolvedAt: new Date(), retryRequestedAt: null })
      .where(and(eq(failures.sourceId, file.id), eq(failures.sourceRootId, file.rootId),
        eq(failures.destinationRootId, this.destinationRootId)));
    this.unresolvedKeys.delete(key);
  }
}

/** These hash routes are emitted by the portal's own public navigation bundle. No API credentials in links. */
export function shufflrrFailureLinks(origin: string, parentId: number, fileId: number, historyId?: number | null) {
  const folderUrl = new URL("/Shufflrr", origin);
  folderUrl.hash = `!/?section=browse&search_parentFolderId=${parentId}`;
  const fileUrl = new URL(folderUrl);
  fileUrl.hash = historyId
    ? `!/?section=presentations&folder=${parentId}&mode=files&tab=details&historyFile=${historyId}`
    : `!/?section=presentations&folder=${parentId}&mode=slides&file=${fileId}&slideIndex=0&details=true`;
  return { fileUrl: fileUrl.href, parentFolderUrl: folderUrl.href };
}
