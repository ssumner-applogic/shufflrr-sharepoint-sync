---
name: Identity administration
description: Distinguish the user's AD FS terminology from evidence of Entra app registration.
---
The user described the connection as managed in AD FS and selected AD FS Application Groups when asked about credential origin. However, the subsequently supplied application manifest was a Microsoft Entra application manifest. Do not treat the earlier answer as proof that no Entra app registration exists.

**Why:** The earlier AD FS explanation was premature; a screenshot also revealed that a secret ID had been stored where the secret Value belonged. Authentication failures alone do not identify the credential issuer.

**How to apply:** Prioritize concrete manifest and runtime evidence over ambiguous identity-provider terminology. Distinguish invalid credentials from delegated-only permissions and missing site grants. Do not ask for a new app registration merely because the organization uses AD FS.

Clerk is not involved in this application. The user clarified that the Clerk configuration was only an example of how they connected previously.

**Why:** The user explicitly corrected an inference drawn from the uploaded manifest's callback URL.

**How to apply:** Keep this browser's connection app-only through Microsoft Graph. Do not add Clerk or treat its example callback as a dependency.
