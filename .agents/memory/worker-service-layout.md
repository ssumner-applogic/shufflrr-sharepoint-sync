---
name: Worker service layout
description: Why production keeps file and metadata workers in one service but separate processes
---

Keep the website/API service separate, and host supervised file-sync and metadata
processes inside the existing `sync-worker` service rather than adding a third
Railway service.

**Why:** The user explicitly approved keeping two services while preserving
independent worker-process failure/restart behavior. Metadata must not run in
the same Node process as file sync.

**How to apply:** Preserve separate schedules, database claims and activity logs.
Do not replace this with shell backgrounding or assume process isolation also
isolates container restarts, memory limits or provider API limits. Preview's
managed startup is a separate concern; preserve its existing launch composition.
