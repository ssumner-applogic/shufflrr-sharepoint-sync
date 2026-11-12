---
name: Visible persistent file ignore rules
description: User-approved discoverability, identity scope, and re-enable semantics for file ignores.
---

Persistent file ignores must be discoverable through dashboard counts, a collapsible Ignored files panel, and a folder-configuration indicator. Re-enabling restores normal conflict protection, not automatic overwrite permission.

**Why:** The user explicitly accepted this design after asking how an ignored file could be re-enabled and how they would know an ignore rule was active.

**How to apply:** Keep rules tied to source-file identity within a particular source/target pairing, not just filename. Preserve both copies while ignored and keep ignored totals separate from failed and synchronized totals.
