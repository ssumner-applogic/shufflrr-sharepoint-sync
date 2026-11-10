---
name: Neon connection transfer
description: Neon MCP project access, CLI authentication, and password-bearing connection-string handoff in Replit.
---

The Replit Neon integration can manage projects, but its privileged connection-string result may be blocked by the credential-transfer guard, even after the user authorizes the transfer. Do not retry or route around that guard. Neon CLI authentication is separate from the Replit integration; headless CLI login can time out and leave `neon init` unauthenticated.

**Why:** Avoid exposing a password-bearing `DATABASE_URL` in tool output or logs, and avoid repeated failed setup attempts.

**How to apply:** Use Neon CLI only when its browser-authenticated login completes. Otherwise, direct the user to copy the URL from Neon Console into the destination provider's secret UI. Never print the URL.
