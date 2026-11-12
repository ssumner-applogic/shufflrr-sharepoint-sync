import type { SyncRunFileProgress } from "@workspace/db/schema";

/** One terminal result per source file, regardless of duplicate notices or event retries. */
export class SyncFileProgress {
  readonly counts: SyncRunFileProgress;
  private readonly expectedKeys: Set<string>;
  private readonly processedKeys = new Set<string>();

  constructor(fileKeys: Iterable<string>) {
    this.expectedKeys = new Set(fileKeys);
    this.counts = { totalFiles: this.expectedKeys.size, processedFiles: 0 };
  }

  record(fileKey: string): void {
    if (!this.expectedKeys.has(fileKey) || this.processedKeys.has(fileKey)) return;
    this.processedKeys.add(fileKey);
    this.counts.processedFiles++;
  }
}
