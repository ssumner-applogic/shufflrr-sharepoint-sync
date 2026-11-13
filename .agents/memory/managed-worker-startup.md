---
name: Managed app and worker startup
description: Preserve artifact service launch references when adding an independent console worker.
---

Adding a manual console workflow can create a Project Run-button workflow containing only that new worker. Preserve references to the existing managed artifact workflows in the Project launch; never configure replacement web/API services.

**Why:** The workflow configuration helper generated a worker-only launch, which would leave the app stopped after a clean Run-button start even though already-running previews looked healthy.

**How to apply:** Check the Run-button composition after adding a worker, use the schema-validated `.replit` replacement flow when changing the composition, and verify the whole Project launch. Development workers should not depend on output being compiled concurrently by another workflow; the existing TypeScript runner avoids that startup race.

When moving independently running services into a grouped launcher, stop the old instances before launching the group to avoid duplicate listeners. Restart registered artifact services by their managed names: aggregate Project restart monitoring timed out even though its child logs showed healthy servers, while individual managed restarts succeeded. Check child health and Preview responses rather than assuming aggregate status identifies an application error.
