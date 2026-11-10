---
name: Neon connection transfer
description: Neon MCP project access, CLI authentication, and password-bearing connection-string handoff in Replit.
---

The Replit Neon integration can manage projects, but its privileged connection-string result may be blocked by the credential-transfer guard, even after the user authorizes the transfer. Do not retry or route around that guard. Neon CLI authentication is separate from the Replit integration; headless CLI login can time out and leave `neon init` unauthenticated.

**Why:** Avoid exposing a password-bearing `DATABASE_URL` in tool output or logs, and avoid repeated failed setup attempts.

**How to apply:** Use Neon CLI only when its browser-authenticated login completes. Otherwise, direct the user to copy the URL from Neon Console into the destination provider's secret UI. Never print the URL.

Once the user stores the URL as a Railway shared variable, attach it to services using `${{shared.DATABASE_URL}}` rather than retrieving or copying its value. Shared-variable existence alone does not mean a service receives it.

**Why:** Reference linking preserves secret isolation and avoids mistaking an unlinked shared variable for a missing secret.

**How to apply:** Inspect environment-level shared names as well as service variable names. Stage references for the API and worker; leave applying the pending deployment to the user.
