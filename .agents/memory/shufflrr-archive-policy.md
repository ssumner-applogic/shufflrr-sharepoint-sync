---
name: Shufflrr archive policy
description: Why archive handling requires an explicit provider marker and an opt-in deletion policy.
---

Archiving does not remove a file from Shufflrr's normal folder contents listing. The live archived-file response used `storageStatus: "MovedToGlacier"`, rather than a generic deleted flag. Never infer archive state from a gray icon, name, date, or missing cached entry.

**Why:** The user expects an optional setting to remove archived files from SharePoint while keeping them visible, gray and labeled Archived, in the Shufflrr browser. Absence-based mirror deletion alone cannot satisfy this.

**How to apply:** Keep the policy opt-in, preserve ignored/excluded/unmanaged content, and require a complete full scan plus verified destination identity/version before removal. Targeted retries never delete. Restoring a source file permits normal sync, not permission to overwrite unrelated content. Update every worker sharing the database before enabling archive handling; an older worker can otherwise recreate archived copies.
