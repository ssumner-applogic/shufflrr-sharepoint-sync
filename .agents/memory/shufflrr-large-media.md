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

Do not treat every route in Shufflrr's public bundle as a supported current UI link; it also contains legacy Browse-table code.

**Why:** The user observed that folder-only Presentations links stayed on the home screen and legacy Browse `search_parentFolderId` links produced an empty page, despite the API confirming the folder and its contents.

**How to apply:** Inspect the active Presentations search handler: it explicitly activates file results and maps `search_searchFolders` to a parent-folder filter. Keep file-detail links separate, and distinguish route/source checks from actual signed-in browser verification.

Microsoft Graph upload acknowledgements can contain bounded missing-byte ranges, not only open-ended ranges.

**Why:** A live SharePoint upload returned a valid bounded range after its first chunk; treating that response as an error caused repeated failures on multi-chunk files.

**How to apply:** Validate range offsets numerically against sequential progress and total size. Retain truncation, final-commit and integrity checks.

SharePoint can rewrite Office document packages during upload by adding library-property metadata, changing size and hash even when slides and media are unchanged.

**Why:** A live PowerPoint read-back preserved every original slide/media part but added custom XML and document properties, changing its size.

**How to apply:** Distinguish provider metadata processing from incomplete transport. Do not claim an Office file has a matching checksum without checking.

The user approved normal SharePoint Office metadata processing, while requiring the original source size to remain separately tracked.

**Why:** They want meaningful size comparisons despite SharePoint's added metadata.

**How to apply:** Retain original transferred/source bytes and actual stored bytes separately. Never invent a SharePoint "size without metadata" or subtract a guessed overhead. Confirm complete Office commits independently, and keep strict size checks for non-Office formats.

A path conflict can be a copy left by an earlier upload whose verification failed, not necessarily an unrelated manually added file.

**Why:** Live investigation found untracked destination copies after earlier chunk-acknowledgement and Office-size verification failures. The provider had retained content although the agent had never recorded a successful mapping.

**How to apply:** Explain the distinction between upload failure history and a current ownership conflict. Do not automatically adopt or overwrite a same-named untracked file; require explicit resolution or reliable content verification.
