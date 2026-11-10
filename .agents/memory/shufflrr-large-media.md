---
name: Shufflrr large media
description: Product expectations for large video sources and an undocumented portal-link distinction.
---

Shufflrr source content includes video files of hundreds of megabytes, not only small presentations.

**Why:** The user said videos will easily be as large as the illustrated 175.7 MB presentation.

**How to apply:** Keep file-type handling general and transfers bounded in memory; do not assume presentation-only or small source assets.

Verify browser deep-link formats against the target portal's own public navigation bundle when changing them.

**Why:** Its non-slide file-details links use a file-history identifier distinct from the file identifier used by slide-view links; REST API paths are not equivalent browser URLs.

**How to apply:** Preserve available file-history metadata and check the portal's current native links if navigation changes. Never put service-account cookies, API credentials or signed upload URLs in browser links.
