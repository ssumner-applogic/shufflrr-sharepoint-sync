---
name: Sync control timestamps
description: Do not use runtime status timestamps to infer a new manual sync request.
---

A timestamp used to detect user control requests must change only for actual configuration, Start, or Sync now actions—not for the worker's own status updates.

**Why:** Marking a run as running automatically changed the shared update timestamp. Completion then mistook that change for a newer Start request and preserved an already-due next-run time, causing repeated scans despite a five-minute interval.

**How to apply:** Separate control revisions from runtime bookkeeping, and verify that completing a run schedules the next normal poll while still preserving genuine control requests made during the run.

Every worker writing that configuration must follow the same timestamp contract; fixing Preview alone does not change an already-deployed worker.

**Why:** An older deployed worker continued writing runtime updates and producing rapid runs after the Preview server was stopped. Its writes could still be mistaken for new manual control requests by other workers.

**How to apply:** If a tested scheduling fix appears ineffective, compare deployment runtime logs with database run times and observe whether writes continue with Preview stopped. Verify active producers and compatible versions before attributing the problem to the UI or declaring the loop resolved.
