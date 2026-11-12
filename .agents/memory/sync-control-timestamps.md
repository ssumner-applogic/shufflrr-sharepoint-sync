---
name: Sync control timestamps
description: Do not use runtime status timestamps to infer a new manual sync request.
---

A timestamp used to detect user control requests must change only for actual configuration, Start, or Sync now actions—not for the worker's own status updates.

**Why:** Marking a run as running automatically changed the shared update timestamp. Completion then mistook that change for a newer Start request and preserved an already-due next-run time, causing repeated scans despite a five-minute interval.

**How to apply:** Separate control revisions from runtime bookkeeping, and verify that completing a run schedules the next normal poll while still preserving genuine control requests made during the run.
