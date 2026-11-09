---
name: Identity administration
description: Distinguish the user's AD FS terminology from evidence of Entra app registration.
---
The user described the connection as managed in AD FS and selected AD FS Application Groups when asked about credential origin. However, the subsequently supplied application manifest was a Microsoft Entra application manifest. Do not treat the earlier answer as proof that no Entra app registration exists.

**Why:** The earlier AD FS explanation was premature; a screenshot also revealed that a secret ID had been stored where the secret Value belonged. Authentication failures alone do not identify the credential issuer.

**How to apply:** Prioritize concrete manifest and runtime evidence over ambiguous identity-provider terminology. Distinguish invalid credentials from delegated-only permissions and missing site grants. Do not ask for a new app registration merely because the organization uses AD FS.

The user is setting up Clerk email login for this app. Its frontend is React + Vite and its API is Express, not Next.js.

**Why:** On 2026-11-09, the user said they were configuring Clerk email login; this supersedes their earlier clarification that Clerk was only an example.

**How to apply:** Follow React/Vite client and Express server patterns for Clerk integration. Keep Microsoft Graph app-only credentials separate and server-side.

For administrator Graph PowerShell sign-in on the user's Windows environment, prefer device-code authentication when the WAM interactive popup fails.

**Why:** The user confirmed device-code sign-in succeeded after interactive sign-in failures.

**How to apply:** Use the administrator's delegated connection only to manage site grants; do not confuse successful administrator sign-in with the browser application's SharePoint authorization.
