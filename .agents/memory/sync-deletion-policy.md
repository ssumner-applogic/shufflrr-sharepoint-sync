---
name: Sync deletion policy
description: Why verified deletion-first runs were chosen and what must remain protected
---

The user approved verified deletions before transfers, rather than postponing all mirror deletions whenever any upload fails.

**Why:** A single persistently failing file must not indefinitely block unrelated deletion cleanup. The user specifically raised the risk of an accumulating backlog.

**How to apply:** Revalidate against the current complete source scan and destination snapshot, not a stale deletion list. Retain protections for excluded and unmanaged SharePoint content, and for live children awaiting a move. Do not restore a blanket upload-success prerequisite for deletions.
