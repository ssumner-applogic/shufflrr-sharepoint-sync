---
name: Visible persistent file ignore rules
description: User-approved discoverability, identity scope, and re-enable semantics for file ignores.
---

Persistent file ignores must be discoverable through dashboard counts, a collapsible Ignored files panel, and a folder-configuration indicator. Re-enabling restores normal conflict protection, not automatic overwrite permission.

**Why:** The user explicitly accepted this design after asking how an ignored file could be re-enabled and how they would know an ignore rule was active.

**How to apply:** Keep rules tied to source-file identity within a particular source/target pairing, not just filename. Preserve both copies while ignored and keep ignored totals separate from failed and synchronized totals.

Approved overwrites of untracked conflicts must resolve the destination path live, even when the incremental SharePoint inventory omits it. Keep the approved item/version precondition; never infer overwrite authority from a matching name alone.

**Why:** Saved approvals persisted correctly, but missing destination entries in the delta cache made the worker attempt a create-only upload and repeat the conflict without using the approvals.

**How to apply:** Verify live identity, version, parent, and ownership before transfer; retain approval after failure and consume it only after verified upload and mapping persistence.
