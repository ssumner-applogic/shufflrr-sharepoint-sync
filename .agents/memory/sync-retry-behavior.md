---
name: Grouped retry behavior
description: User-approved scope and result visibility for Retry all failed.
---

“Retry all failed” should be one clearly labeled targeted job, with progress for the queued group and its results kept selected when a later full sync starts.

**Why:** The user could not tell what retrying three files did when each became a separate run and the activity log subsequently showed a full scheduled sync.

**How to apply:** Share necessary discovery across the group, transfer only requested files, preserve deletion safeguards, and distinguish discovery work and full-scope dashboard refreshes from retry outcomes.
