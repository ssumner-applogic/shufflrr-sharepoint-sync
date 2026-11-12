---
name: Neon pooled worker locks
description: Session-scoped advisory locks can outlive a completed sync on transaction-pooled connections.
---

Use transaction-scoped advisory locks in an open transaction for whole-run synchronization on Neon pooled connections.

**Why:** An idle pooled PostgreSQL backend retained a session advisory lock after the saved run had completed, blocking both control operations and schema migration. A checked-out JavaScript pool client does not establish backend-session affinity through transaction pooling.

**How to apply:** Pin the lock connection with a transaction until cleanup, release it by ending the transaction, and keep migration lock waits bounded. Set timeouts with transaction-local SQL rather than startup PGOPTIONS, which the pooled endpoint rejects. Never terminate a possible active worker session without operator approval.

Transaction pooling can reuse the lock-holding backend for an unrelated diagnostic query. Its current query does not identify the original lock owner; an apparent active diagnostic statement is not evidence of an active sync.

A granted advisory lock on an idle backend with no open transaction is not the current transaction-scoped run lock. Do not infer an active sync from that lock alone, or infer its originating deployment from its latest query.

**Why:** A retained session lock blocked updated workers before they could create a run journal; the UI still showed the previous completed run. The connection later disappeared and scheduled runs resumed without intervention.

**How to apply:** Correlate lock scope, transaction state, and run history. A fresh fetch of an old completed run must not clear a new busy-lock error.
