# Sync activity and first-run timing

## Recursive selection and exclusions

Selected Shufflrr roots include all descendants. Expanded descendants show inherited checks; unchecked subfolders exclude their entire subtree, and affected ancestors show a mixed check state. To change scope, pause sync, uncheck unwanted subfolders, save settings, then enable sync. Rechecking an excluded folder includes its subtree again. Descendants of an excluded folder stay unchecked; reinclude their parent first.

Exclusions are stored in Neon and enforced by the worker, not just the tree UI. Existing excluded SharePoint copies and their mappings are retained; newly excluded mapped folders appear in **No longer syncing** notices, with manual deletion advised. Excluded items are reported as skipped in the activity log. Folder deletions that would recursively remove excluded or unmanaged copies are blocked. Deploy migration `0004_sync_folder_exclusions` and the updated worker before using exclusions. Test tree selection with `pnpm test:sync-selection`.

Enabling sync makes its first run due immediately, rather than waiting for the polling interval. The private worker checks for newly enabled work within approximately one second; an active provider cooldown still takes priority. Changing polling intervals does not bypass cooldowns or allow overlapping runs.

The Sync Agent's expandable **Activity log**, directly beneath its status banner, lists the most recent 50 runs. Choose a run and filter its paginated file/folder outcomes: copied, updated, created, moved/renamed, deleted, unchanged, conflicts, failures, and skipped items. Full-run counts are independent of the selected page. A completed run with conflicts is labeled separately from a successful run.

Partial progress and conflict details survive later failures. Failed items include their relative paths and safe reasons; source items not attempted after a fatal error are explicitly marked skipped. Files up to **300 MB (300,000,000 bytes)** are supported. A failed run stops further provider writes and deletions rather than implying remaining items succeeded.

File notices are grouped by current outcome: actionable failures are shown individually, while files not attempted after a run stops are collected in a collapsed group. Expand a file's issue history to review recent failed, conflicting, and skipped events. Those records follow the same 50-run retention window as the activity log; older entries are not retained.

## Large files and failure banners

The worker streams Shufflrr downloads into sequential 5 MiB Microsoft Graph upload-session fragments, including files above Graph's 250 MB simple-upload limit. Memory is bounded by the upload fragment rather than the entire file. Source length/EOF and Graph's final ID/size acknowledgement must validate before sync succeeds. Failed sessions are canceled best-effort, and provider-directed pacing/backoff still applies. Download streams have a bounded 15-minute deadline; each fragment has a 120-second timeout. Transfers do not depend on local disk or browser uptime.

Unresolved file failures and file-name conflicts appear as persistent, paginated banners below the sync status. Each gives the reason, **Open file in Shufflrr**, **Open parent folder in Shufflrr**, **Try again**, and dismiss. Links use the configured portal and its native routes; users may need to sign in to Shufflrr there. Dismissal does not disable sync or cancel an already queued retry. An unchanged failure stays dismissed; a changed source version/reason or recurrence after resolution reappears.

**Try again** queues a durable, one-file retry, even while automatic sync is paused. The private worker processes queued files sequentially; a retry checks the saved scope/exclusions, reconciles only that file and necessary ancestors, never performs mirror deletions, and respects provider cooldowns. A configuration change that removes the file from scope prevents the retry. Successful reconciliation resolves its banner automatically. A fatal retry failure leaves a safe reason and allows another attempt. Run `pnpm db:migrate` for additive migrations `0005_sync_file_failures` and `0006_sync_file_failure_issues` before updating both API and worker; no new environment variables are needed.

Apply `pnpm db:migrate` before running this release. Migration `0003_sync_activity_log` adds protected PostgreSQL history tables without changing provider content or existing settings/mappings. Both API and worker must run the updated code against the same database. Only log metadata older than the latest 50 runs is automatically pruned. The first new run preserves any available pre-upgrade last-known result and conflicts as an explicitly marked historical result; detailed successful file paths cannot be reconstructed retroactively.

# Shufflrr-SharePoint Sync Agent

A sign-in-protected SharePoint and Shufflrr document browser with access diagnostics. Microsoft app-only credentials, the Shufflrr service-account credentials, and provider session cookies remain on the server. Clerk handles app sign-in.

## Local setup

1. Install Node.js 24 and pnpm 10.26.1.
2. Run `pnpm install --frozen-lockfile`.
3. Set these values in the workspace's secret manager:
   - Clerk: `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
   - Microsoft Graph: `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, and `MICROSOFT_CLIENT_SECRET`.
   - Optionally `SESSION_SECRET` for signing pagination cursors independently of the Microsoft client secret.
4. Apply the additive sync schema to the development database with `pnpm db:migrate`.
5. Start the Replit-managed API and web workflows.

The Clerk publishable key is served to the web app by `/api/auth/config`; it is public by design. The Clerk secret key and Microsoft credentials remain server-only. Email/password sign-in and whether users can sign up are controlled by the selected Clerk application's settings.

Useful commands:

- `pnpm run typecheck` — check all workspace packages.
- `pnpm run build` — production-build the SharePoint web app and API.
- `pnpm start` — run the combined production server. It uses `PORT` supplied by the host.
- `pnpm db:migrate` — explicitly apply the PostgreSQL schema migration.
- `pnpm sync:run` — execute one sync pass; `pnpm --filter @workspace/api-server run sync:watch` runs the continuous worker.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for Railway and Google Cloud Run setup, health checks, and production secrets.

## Continuous Shufflrr sync

The Sync Agent stores one shared configuration in PostgreSQL. All signed-in Clerk users can edit it. Each selected Shufflrr folder is mirrored into a same-named folder under the selected SharePoint destination. Source edits, renames, moves, and deletions are mirrored; changed SharePoint copies are overwritten from Shufflrr. Only mapped items inside the configured destination are deleted. Existing SharePoint path conflicts and SharePoint-only items are reported and left untouched.

When a source folder is deselected or the destination changes, existing copies remain. The app lists the detached source/destination pairs until a user dismisses each notice; users can delete those old SharePoint copies manually if wanted. Files larger than 100 MiB are not synced.

In Replit development, the API workflow checks for enabled sync every minute. In Railway production, run a separate continuous worker service with `node --enable-source-maps artifacts/api-server/dist/sync-watch.mjs`. Railway Cron Jobs have a five-minute minimum interval, so they cannot meet the selected one-minute polling interval. See [DEPLOYMENT.md](DEPLOYMENT.md) for production database and worker setup, including the required SharePoint `Sites.Selected` write grant.

## Shufflrr API validator (standalone CLI)

This operator-only, read-only tool signs in with a dedicated **Shufflrr service account**, then recursively lists the folders and files visible to that account. It is independent of Clerk and shares its validated API client with the Shufflrr Viewer.

Configure `SHUFFLRR_API_BASE_URL` with your portal's HTTPS URL ending in `/api`. Store `SHUFFLRR_API_EMAIL` and `SHUFFLRR_API_PASSWORD` in Replit Secrets (or your local environment/hosting secret manager), never in source code or command-line arguments. These variables are optional for the web app and required only by the CLI. They are not frontend `VITE_*` variables. The command uses existing environment variables; it does not automatically load `.env` files.

```sh
pnpm shufflrr:validate
pnpm shufflrr:validate --ascii --max-folders 5000 --max-depth 100 --max-items 100000 --timeout-ms 20000
pnpm shufflrr:validate --help
pnpm test:shufflrr
```

For clean redirected tree output without pnpm's command banners, use `pnpm --silent shufflrr:validate`. If saving a tree to disk, choose a private location outside Git and restrict access to that file.

Example output below is illustrative, not live account data:

```text
Shufflrr/
└── Presentations/ [reported: Read]
    ├── Archive/ [reported: Read]
    │   └── Overview.pptx
    └── Introduction.pdf
```

- Verifies the login response, a usable session cookie, root listing, and actual folder-content reads. Cookies stay in process memory and are discarded when the command exits.
- Shows `userPermissions` **as reported** by Shufflrr. Numeric values are not decoded. Successful reads do not prove upload, write, delete, or administrative access; no write probes are performed.
- Lists accessible root folders with `GET /api/folders`, then traverses `GET /api/folders/{id}/contents/false`. The final `false` is the `includeDelete` parameter required by the current official Swagger schema. This is not a deleted-file inventory or an inventory of hidden/inaccessible portal content.
- Checks response schemas and rejects unexpected envelopes rather than treating them as empty results. Current documented listing responses are full arrays, without pagination; the tool has no invented page/cursor parameters. A portal with a different schema must be adapted explicitly.
- Sorts folders before files. Empty folders remain visible. Unreadable subtrees and cycles are marked in the tree; accessible siblings are still scanned. A 401 stops further folder requests. Timeouts and safety limits produce explicit failures, never silent truncation.
- Defaults: 20-second per-request timeout, at most 5,000 folder-read attempts, depth 100 below roots, and 100,000 discovered entries. Hard response limits are 10 MiB and 100,000 records per response. Options permit timeout 1–120,000 ms, folder attempts 1–100,000, depth 0–1,000, and total items 1–1,000,000. Only idempotent GETs retry HTTP 429/502/503/504 (at most twice, bounded delay); login is never retried automatically.
- Exit `0`: login/listing passed and the visible tree is complete. An empty root list explicitly says folder-content permissions could not be verified. Exit `1`: configuration, login, or root-list failure. Exit `2`: partial tree.
- The tree and summary go to stdout; one-line JSON diagnostics go to stderr. Diagnostics contain route templates, request IDs, status, and duration—not credentials, cookies, bodies, folder/file names, or sensitive record identifiers. Use `LOG_LEVEL=warn` or `LOG_LEVEL=error` to reduce diagnostics.
- Tree output contains business folder/file names. Treat it as private, and do not commit it to Git or expose it through a public endpoint.

No web workflow, database migration, or deployment change is required. Run this as an explicit operator command, not as web-server startup or a cron job. On Railway, install workspace development dependencies in a separate operator environment if needed (`tsx` runs the TypeScript CLI); the production web image is unchanged.

API references: [Shufflrr's official guide](https://shufflrr.com/api-docs/) and [official Swagger schema](https://wwwapi.shufflrr.com/api/docs/v1).

## Live Shufflrr Viewer and scoped access tests

Set the same three `SHUFFLRR_API_*` variables on the API server to enable the signed-in Shufflrr Viewer. Both viewers show expandable folder-and-file trees: roots load automatically in the active tab, and child folders load only when expanded. Multiple branches can remain open at once. Expansion state is retained across tab switches, with loading, empty, and error/retry states per branch. SharePoint's per-folder Load more action appends additional pages rather than replacing already visible children. SharePoint files retain their external document links; Shufflrr files retain protected downloads.

Shufflrr downloads are authenticated server-side, streamed without disk persistence, limited to 100 MiB and a 60-second upstream request timeout. API redirects are deliberately rejected rather than forwarding credentials to another host.

Every `/api/shufflrr/*` operation requires a Clerk session and same-origin request. Under the existing product policy, accounts managed in the configured Clerk instance can access the single configured service-account portal. The browser cannot choose another portal, supply credentials, or change the acting service principal. Shufflrr itself enforces the service account's per-folder/file authorization.

Shufflrr authentication is reused for the lifetime of each **Clerk app session**, not an arbitrary five-minute timer. On first use, the server verifies that session's owner/status and obtains its actual expiry/abandonment deadline from Clerk. Connection cookies remain server-only, keyed by the verified session ID (not merely user ID), with concurrent requests sharing one login. The header logout action calls authenticated `POST /api/shufflrr/session/end` before Clerk sign-out, clearing only that app session's connection; Clerk sign-out still proceeds if server cleanup cannot be confirmed. Expired entries are swept every minute and all connections are cleared on graceful shutdown. No folder data is cached server-side.

This disposable in-memory pool is limited to 256 active/pending app-session connections per server instance; capacity produces a clear error rather than evicting another active user's connection. A process restart, request routed to another instance, or Shufflrr's own cookie expiry can require authentication again. Reads retry authentication once if the provider expires its session sooner. No sticky sessions, database-backed credentials, or external cache are required for correctness. Access diagnostics deliberately use a separate short-lived connection to verify credentials afresh and isolate temporary-item checks.

The Access Test panel now contains a separate Shufflrr section. Choose a root and explicitly confirm temporary changes before running. It verifies root read, folder create/read/rename, file upload/download/rename, file deletion, and folder deletion. It only alters uniquely named temporary test items; cleanup is attempted on failure and never recursively deletes unexpected content. Results apply to the chosen folder and newly created items, not every descendant or the whole portal. Shufflrr's normal delete may retain items in its recycle/trash system; this is not a purge test.

For an **explicit operator-only test across all accessible roots**:

```sh
pnpm --silent shufflrr:probe --confirm-temporary-changes
```

This creates and cleans up temporary folders/files, so do not run it as startup, a background schedule, or an ordinary read-only scan. Reports go to stdout and can contain folder names; keep them private. A nonzero exit indicates some operation was denied/unverified or cleanup requires attention.

If shared folders remain read-only, a Shufflrr administrator must grant the service account (or its dedicated API group) **Full Control on the intended folders and child folders**, preserving existing users' permissions. The group must also have the necessary upload/download rights. Do not assume a parent grant changes every existing child's explicit permissions. The application does not bypass permissions, expose ACL administration endpoints, or automatically grant itself privileges.

## Sync polling and throttling

The Sync Agent's **Shufflrr polling** selector saves automatically and is shared across signed-in users. Available intervals are **1 second, 5 seconds, 30 seconds, 60 seconds (default), 5 minutes, and 60 minutes**. It can be changed without pausing sync or replacing folder selections. Intervals are minimum gaps after a completed attempt, not promises of one-second freshness for large trees. Runs never overlap; the selected interval, request pacing, run duration, and provider cooldowns determine actual freshness.

Provider requests are paced per process (250 ms between starts by default). Optional `SHUFFLRR_REQUEST_INTERVAL_MS` and `SHAREPOINT_REQUEST_INTERVAL_MS` accept 50–60000 ms. These settings do not bypass provider limits. Both clients respect numeric and HTTP-date `Retry-After` headers, use bounded exponential backoff with jitter when no valid delay is provided, and never replay ambiguous non-idempotent 5xx writes. Login is not automatically replayed. Long/exhausted cooldowns defer background work and persist its retry deadline in PostgreSQL; changing the interval or toggling sync does not bypass that deadline.

The first SharePoint sync builds a bounded **document-library-wide metadata baseline** using Microsoft Graph delta. Subsequent runs request changes using a server-only PostgreSQL cursor instead of recursively listing every destination folder. Expired tokens rebuild the baseline; incomplete pages never advance the cursor or permit reconciliation. Folder moves/renames are resolved by ID, and successful local writes update the snapshot immediately. This metadata snapshot is separate from the viewer caches; no file contents or authentication tokens are stored in it. Shufflrr still requires scanning selected source folders because no verified incremental feed is configured.

Apply the additive `0002_sync_polling_delta` migration with `pnpm db:migrate` before running the updated API/worker. It preserves existing sync configuration and mappings. Run `pnpm --filter @workspace/api-server run test:sync` and `pnpm test:shufflrr` for the focused regression checks.
