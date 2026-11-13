---
name: File metadata provenance
description: User requirements for retaining Shufflrr metadata and retrieving it by SharePoint file identity.
---

Capture only the user's allowlisted descriptive/identity fields, Shufflrr activity dates/actors, and original-file dates. Do not expand into tags, slide/media details, genealogy, history or raw provider payloads. Keep activity dates, original-file dates and app observation timestamps distinct.

**Why:** The user wants lookup by SharePoint file identity and explicitly narrowed the source metadata scope.

**How to apply:** Keep metadata capture in a separate process and UI/log so failures cannot obstruct file sync. Detect metadata-only changes independently of filenames. Never overwrite native SharePoint dates/actors or add custom fields for this feature. Source user IDs and names are not Microsoft identity mappings. Test using the first ten existing synchronized files, not newly created representative files. The app serves a handful of people in one organization; preserve existing sign-in/scope protection without inventing a new multi-tenant role framework.
