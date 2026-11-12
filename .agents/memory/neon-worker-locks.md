---
name: Neon pooled worker locks
description: Session-scoped advisory locks can outlive a completed sync on transaction-pooled connections.
---

Use transaction-scoped advisory locks in an open transaction for whole-run synchronization on Neon pooled connections.

**Why:** An idle pooled PostgreSQL backend retained a session advisory lock after the saved run had completed, blocking both control operations and schema migration. A checked-out JavaScript pool client does not establish backend-session affinity through transaction pooling.

**How to apply:** Pin the lock connection with a transaction until cleanup, release it by ending the transaction, and keep migration lock waits bounded. Set timeouts with transaction-local SQL rather than startup PGOPTIONS, which the pooled endpoint rejects. Never terminate a possible active worker session without operator approval.
