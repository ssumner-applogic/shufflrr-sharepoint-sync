---
name: Shufflrr authentication lifetime
description: User's intended lifetime for the Shufflrr service-account connection.
---
Keep Shufflrr server authentication reusable for the duration of the user's signed-in app session, rather than rotating it on a short fixed timer.

**Why:** The user explicitly requested this after learning that authentication was expiring after five minutes.

**How to apply:** Preserve this requirement when changing caching or connection management. Authentication reuse and folder-listing freshness are separate concerns; this request did not ask to make document listings permanently cached.
