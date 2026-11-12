---
name: File metadata provenance
description: User requirements for retaining Shufflrr metadata and retrieving it by SharePoint file identity.
---

Capture Shufflrr metadata in Neon for reference to synchronized files, retrievable using the SharePoint file ID. Keep it current when sync actions affect the metadata and when source metadata changes without a filename change. Account for metadata that differs by file type.

**Why:** The user wants to look up a SharePoint file and retrieve its related Shufflrr metadata, not just maintain a filename/content copy.

**How to apply:** Treat metadata freshness separately from filename and binary-transfer state. Assess preservation of built-in SharePoint dates and Created By/Modified By without introducing custom SharePoint metadata fields. The user has not yet chosen between Shufflrr activity dates and original-file dates for native SharePoint attribution.
