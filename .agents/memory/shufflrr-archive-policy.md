---
name: Shufflrr archive policy
description: Why archive handling requires an explicit provider marker and an opt-in deletion policy.
---

Archiving does not remove a file from Shufflrr's normal folder contents listing. The live archived-file response used `storageStatus: "MovedToGlacier"`, rather than a generic deleted flag. Never infer archive state from a gray icon, name, date, or missing cached entry.

**Why:** The user expects an optional setting to remove archived files from SharePoint while keeping them visible, gray and labeled Archived, in the Shufflrr browser. Absence-based mirror deletion alone cannot satisfy this.

**How to apply:** Keep the policy opt-in and preserve ignored/excluded/unmanaged content. A complete full scan plus a direct lookup of the current scoped destination identity/version authorizes removal, including copies changed since synchronization. Do not require the historical content tag to match. Targeted retries never delete. Restoring a source file permits normal sync, not permission to overwrite unrelated content. Update every worker sharing the database before enabling archive handling; an older worker can otherwise recreate archived copies.

The user explicitly confirmed that enabling archive deletion means deleting the synchronized copy, not retaining it as a review conflict because its content changed.

**Why:** A combined “changed or could not be verified” conflict hid a missing cached version tag even when the live copy matched. Delta snapshots and old cursors can omit version tags, so the destructive action must retrieve its own current version instead of trusting the snapshot to contain it.
