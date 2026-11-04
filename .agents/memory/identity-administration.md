---
name: Identity administration
description: Confirmed AD FS Application Groups origin of the supplied application credentials.
---
The user confirmed that the supplied client ID and secret were created in **AD FS Application Groups**, not Microsoft Entra App registrations.

**Why:** AD FS application credentials and Microsoft Entra app-registration credentials are not interchangeable. Assuming the issuer could lead to repeated unnecessary credential replacements.

**How to apply:** Do not repeatedly ask the user to recreate AD FS secrets for the Entra token endpoint. For app-only Microsoft Graph access to SharePoint Online, obtain a Microsoft Entra application identity and appropriate Graph permissions, even when employee sign-in is federated through AD FS.
