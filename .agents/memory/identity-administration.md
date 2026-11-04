---
name: Identity administration
description: User-reported AD FS management and the unresolved credential issuer distinction.
---
The user says this connection is “managed in ADFS.” It is not yet confirmed whether that means employee sign-in is federated through AD FS or the application's credentials were created in AD FS.

**Why:** AD FS application credentials and Microsoft Entra app-registration credentials are not interchangeable. Assuming the issuer could lead to repeated unnecessary credential replacements.

**How to apply:** Before changing the authentication flow, clarify where the application is registered. For app-only Microsoft Graph access to SharePoint Online, use the Microsoft Entra application identity even when employee sign-in is federated through AD FS.
