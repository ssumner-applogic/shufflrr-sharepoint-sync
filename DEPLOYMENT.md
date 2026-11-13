# File-resolution release

Before serving this release, run the explicit additive migration `pnpm db:migrate` to create `sync_file_rules`. Deploy both the app/API and every sync worker connected to that database before enabling ignore/overwrite rules; older workers do not honor them. No new environment variables or container changes are needed. Migrations now fail safely on prolonged lock contention instead of waiting indefinitely. If a completed run still owns an old session-scoped advisory lock, have an operator confirm the holder is stale before terminating that database session; do not bypass the lock while another worker is active.

# Shufflrr viewer configuration

Set `SHUFFLRR_API_BASE_URL` (your portal's HTTPS URL ending in `/api`), `SHUFFLRR_API_EMAIL`, and `SHUFFLRR_API_PASSWORD` in the Railway service's production variables, or in Cloud Run environment/Secret Manager configuration. Keep email/password server-only. These Replit development values are not automatically copied to Railway. Missing Shufflrr configuration produces a safe configuration error for its viewer; health checks and other app features remain independent.

The build includes the server-side sync worker. Sync state is stored in PostgreSQL; no sync runs until a signed-in user saves a configuration and enables it. Keep Clerk, Microsoft Graph, Shufflrr, and database credentials server-side.

All Shufflrr app endpoints require a Clerk session and same-origin requests. App accounts managed in that Clerk instance share the configured service-account portal's access, following the existing account policy; there is no new public access or tenant selector. The access-test operation only creates, renames, and deletes isolated test items after explicit confirmation. A Shufflrr administrator controls service-account group rights and folder ACLs. Read access is not proof of write/delete rights, and successful tests in one folder do not prove access throughout the portal.

The server now retains a separate Shufflrr connection per verified Clerk app session, until logout or that session's actual expiry, rather than expiring it after five minutes. The first connection requires Clerk Backend API session lookup using the existing server-only Clerk key; failures return a safe error rather than bypassing validation. Local session connections are bounded to 256 per instance, never persisted, and discarded on graceful shutdown. Reauthentication after provider expiry, instance changes, or process restart is expected and does not require sticky sessions. Deploy frontend and API changes together so header logout can discard its server connection before Clerk signs out. No new variables or migration are required.

# Deployment

## Large-file and failure-banner release

Pause sync for rollout, run `pnpm db:migrate` on the intended Neon database, then deploy the updated worker and matching API/frontend. Migrations `0005_sync_file_failures` and `0006_sync_file_failure_issues` add only persistent file-failure metadata and per-run issue history; they do not change existing sync settings, mappings or provider files. Issue history follows the latest-50-run retention policy. No new variables are required. The worker must be running to process targeted retries, including retries requested while automatic sync is paused.

The file limit is 300,000,000 bytes. Nonempty files use Graph upload sessions with sequential 5 MiB fragments, bounded stream memory, validated final size, and best-effort session cancellation. Signed upload capability URLs are server-only, never logged or sent to the browser, and upload-fragment requests never carry the Graph Authorization header. Provider cooldowns and the existing cross-process advisory lock remain authoritative. Interrupted queued retries survive a worker restart; retry mode cannot perform mirror deletions. Dismissing a banner hides the notice without canceling the queued job or changing automatic sync.

## Subfolder-exclusion release

Pause sync before rolling out this change. Run `pnpm db:migrate` on the intended Neon database; additive migration `0004_sync_folder_exclusions` adds the default-empty `sync_config.excluded_folders` JSONB column. Existing folder selections and provider files are unchanged. Deploy the updated **worker before enabling sync with exclusions**, then the matching API/frontend; an older worker does not understand excluded subtrees. Resume only after both services run the new version. No new environment variables are required.

Folder-configuration requests now explicitly include `excludedFolders` (an empty array means no exclusions), preventing older clients from silently clearing saved exclusions. Stale clients must reload the updated frontend before saving. New exclusions are validated against provider ancestry; unchanged previously verified exclusions remain valid if their source disappears. The worker keeps excluded mappings/copies and protects ancestor folders from recursive deletion of excluded or unmanaged contents.

## Sync activity-log release

Before deploying this version's API and worker, run `pnpm db:migrate` with the intended Neon `DATABASE_URL`. The additive `0003_sync_activity_log` migration creates `sync_runs` and `sync_run_events`; it does not modify files, sync settings, or item mappings. Update both services together. No new environment variables are required.

The worker checks PostgreSQL for newly enabled sync within approximately one second, independent of the selected provider polling interval. These database checks do not call the content providers. Provider cooldowns and the advisory lock remain authoritative. The activity history retains the latest 50 runs and paginates detailed events through authenticated `/api/sync/runs` and `/api/sync/events` routes. Paths and provider continuation links are never written to public logs.

The file-error continuation and failure-panel **Clear all / Retry all failed** updates require deploying the updated API/frontend and private worker together; they add no environment variables or migrations. Full runs now perform verified deletions after successful complete scans and before transfers. Only tracked, in-scope copies absent from the current source scan are eligible; protected or still-live descendants prevent recursive folder deletion. Incomplete scans make no changes, and targeted retries never delete. Known file-local failures allow independent transfers to finish with a partial run status without blocking verified deletion cleanup. Shared provider/permission failures, deletion failures, and failed folder prerequisites stop further work. Bulk retries queue all eligible undismissed unresolved files across pages, then dismiss all current notices; retry failures reappear. The worker uses the existing sequential targeted-retry queue and respects the saved scope and provider cooldowns without enabling automatic sync.

Deploy API/frontend and worker together for cooperative **Pause sync / Start sync** controls. Pausing updates the existing shared enable flag immediately; the worker stops at a safe item boundary rather than aborting a partial upload. This update needs no migration or new variables. An old worker will finish its entire run instead of honoring the new checkpoints.

The production API serves the compiled SharePoint viewer and `/api` routes from one stateless Node.js process, binding to `0.0.0.0` on the host-provided `PORT`. Sync uses a separate worker process and durable PostgreSQL state.

## Independent metadata worker rollout

Before starting this version's metadata API/worker, explicitly apply
`pnpm db:migrate` on the intended Neon database. Additive migration
`0009_file_metadata` creates snapshots, a coalescing control row, and separate
metadata run/event tables. It does not change sync settings, mappings or provider
content. Do not run migrations automatically at startup.

For Railway, deploy a third **private metadata worker** from the same GitHub
repository and image, build with `pnpm run build`, then start with
`pnpm metadata:watch`. Give it `DATABASE_URL`, the existing Microsoft application
variables and `SHUFFLRR_API_*` variables. It needs no public domain or health-check
port. Optional `METADATA_CRAWL_INTERVAL_SECONDS` defaults to 300; existing provider
pacing variables also apply. Do not combine this process with the file worker:
metadata exceptions and restarts must not stop file transfers.

For Cloud Run, use the same image in a separate Cloud Run Job with command
`node --enable-source-maps artifacts/api-server/dist/metadata-watch.mjs --once`,
invoked by Cloud Scheduler. Supply the same server-only credentials through
Secret Manager and a least-privileged service identity. The transaction-scoped
metadata lock makes overlapping invocations skip instead of creating a queue.
An always-on metadata worker can use `pnpm metadata:watch` instead.

For a safe operator check, run `pnpm metadata:check`: only the first ten existing
mapped SharePoint files are verified using Graph reads, and the allowlisted source
metadata is read from Shufflrr and stored in Neon. It never uploads, renames,
deletes or modifies provider files. No representative files are created.

Inspect the protected Metadata activity panel for queued/running/partial/failed
states, progress and per-file results. Stdout uses structured `metadata_*` events
and run request IDs, never source actor/email values. If the worker is stopped,
refresh requests remain queued and the panel reports the missing heartbeat.
Last-good snapshots survive errors; retry cooldowns are durable.
Stop only the metadata service to roll it back; file sync remains independent.
Retain the additive tables during rollback, and redeploy the matching API and
metadata worker before resuming capture. No production deployment is performed
by the development migration or first-ten check.

## Railway

1. Connect the repository and deploy from the repository root. Build with `pnpm run build` and start the API with `pnpm start`.
2. Create a Neon PostgreSQL database for production. Set its connection string as `DATABASE_URL` in both the API and worker services. Keep Replit's development database separate.
3. Add these server-side variables to the API service:
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
   - `MICROSOFT_TENANT_ID`
   - `MICROSOFT_CLIENT_ID`
   - `MICROSOFT_CLIENT_SECRET`
   - `SHUFFLRR_API_BASE_URL`
   - `SHUFFLRR_API_EMAIL`
   - `SHUFFLRR_API_PASSWORD`
   - `DATABASE_URL`
   - Optionally `SESSION_SECRET` for signing pagination cursors independently of the Microsoft client secret.
4. Apply the production database migration once, before enabling sync: run `pnpm db:migrate` with the production `DATABASE_URL` available in a secure release environment. Do not run schema changes at application startup.
5. Set the API service health check path to `/healthz` and deploy it.
6. Create a second, private worker service from the same repository. Build with `pnpm run build`, set the start command to `node --enable-source-maps artifacts/api-server/dist/sync-watch.mjs`, and provide `DATABASE_URL`, the three Microsoft variables, and the three `SHUFFLRR_API_*` variables. No public domain, `PORT`, or Clerk keys are needed by this worker.

Before enabling sync, the Microsoft application must have `Sites.Selected` access with the `write` role granted to the target SharePoint site. The prior access test showed that folder creation was denied, so verify write access succeeds before starting sync; the app cannot grant itself SharePoint permissions. That site grant is required for folder/file create, update, move, and delete operations.

The SharePoint viewer and all SharePoint API routes require a valid Clerk session. `/healthz` remains public for platform health checks; `/api/auth/config` returns only the Clerk publishable key. Configure the deployed domain and email/password sign-in in Clerk. Any signed-in user can change the shared sync configuration. The worker uses the persisted polling interval (1, 5, 30, 60, 300, or 3600 seconds; default 60), does not use a browser session, and exits cleanly on shutdown. A PostgreSQL advisory lock prevents overlapping runs across worker instances.

Before releasing this version, apply `0002_sync_polling_delta` with `pnpm db:migrate` in the release environment, then deploy the API and worker together. This additive migration introduces interval/due-time/cooldown fields and the persistent SharePoint delta snapshot; it does not reset existing settings or mappings. Delta URLs remain server-only and must not appear in logs or API responses.

Optional pacing variables `SHUFFLRR_REQUEST_INTERVAL_MS` and `SHAREPOINT_REQUEST_INTERVAL_MS` default to 250 milliseconds and accept 50–60000. Set these independently on API and worker services if needed. Pacing is per process, not a distributed tenant-wide quota; other applications and instances contribute to the providers' limits. Provider cooldowns override the configured polling interval and survive worker restarts. The worker checks for changed configuration at most every five seconds while waiting; after a run the selected minimum interval applies.

### Sync troubleshooting

Restart the API and worker after changing their database connection so existing connection pools do not keep using the previous database. Schema creation does not migrate saved sync configuration or item mappings: preserve those records when moving an existing sync to another database. An empty database requires a new configuration; existing unmapped SharePoint copies remain conflicts and are not adopted or overwritten automatically.

Failed runs show a safe reason and a reference ID. Find the matching `sync_run_failed` log event by its `requestId`; it records the sync phase and safe provider/database error codes without logging folder paths, file contents, connection strings, or raw database errors. The original failure cannot be reconstructed from older logs that only recorded `development_sync_run_failed`.

Use the always-on worker service above for sub-minute polling; it consumes worker resources while running. When sync is paused it checks shared database configuration but makes no provider sync requests.

Only content mapped by this app inside the currently configured SharePoint destination is updated or deleted. Initial conflicts and untracked SharePoint items are reported and left unchanged. Changing the sync scope retains old copies and creates dismissible notices; users must delete those copies manually if they no longer want them. Source files above 100 MiB are not supported.

## Google Cloud Run

Use the same Dockerfile for the API and a separate Cloud Run Job for periodic sync. Provide the production `DATABASE_URL`, Clerk, Microsoft, and Shufflrr variables through Secret Manager. Apply `pnpm db:migrate` as an explicit release step before enabling sync. Configure `/healthz` for the API service. A Cloud Run Job scheduled more frequently than its supported minimum should be replaced by an always-on worker.

## Local production smoke test

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm db:migrate
PORT=8080 pnpm start
```

Then check `GET /healthz` and `GET /api/sharepoint/status`.
The SharePoint status endpoint returns `401` without a Clerk session. `GET /api/auth/config` is public and returns only the publishable key needed to initialize the Clerk browser SDK.

## Archived source files

Run `pnpm db:migrate` before starting the updated app/worker; the additive archive-policy migration adds `sync_config.treat_archived_as_deleted` with a default of `false`. No environment variables are added. The same migration command applies to Railway and Cloud Run.

Deploy the updated API, frontend and **all** workers sharing this database before enabling **Treat archived files as deleted**. Old workers ignore this setting and can recreate archived SharePoint copies. The setting is not enabled automatically by deployment. In the app, pause sync, open Folder configuration, select the setting, save and resume. The next full scan performs guarded managed-copy removals; targeted retries never delete. Archived items remain labeled in the source viewer and are separated from active dashboard totals when the policy is enabled.

Turning the policy off or restoring/unarchiving a source file permits normal syncing on a later full run. It never authorizes overwriting an unrelated SharePoint file. Version-changed, ignored, excluded and unmanaged destination content is retained. Roll back application code only after pausing sync and disabling the policy; the additive database column can remain in place.
