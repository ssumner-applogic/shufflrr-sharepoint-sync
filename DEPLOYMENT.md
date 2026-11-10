# Shufflrr viewer configuration

Set `SHUFFLRR_API_BASE_URL` (your portal's HTTPS URL ending in `/api`), `SHUFFLRR_API_EMAIL`, and `SHUFFLRR_API_PASSWORD` in the Railway service's production variables, or in Cloud Run environment/Secret Manager configuration. Keep email/password server-only. These Replit development values are not automatically copied to Railway. Missing Shufflrr configuration produces a safe configuration error for its viewer; health checks and other app features remain independent.

The build includes the server-side sync worker. Sync state is stored in PostgreSQL; no sync runs until a signed-in user saves a configuration and enables it. Keep Clerk, Microsoft Graph, Shufflrr, and database credentials server-side.

All Shufflrr app endpoints require a Clerk session and same-origin requests. App accounts managed in that Clerk instance share the configured service-account portal's access, following the existing account policy; there is no new public access or tenant selector. The access-test operation only creates, renames, and deletes isolated test items after explicit confirmation. A Shufflrr administrator controls service-account group rights and folder ACLs. Read access is not proof of write/delete rights, and successful tests in one folder do not prove access throughout the portal.

The server now retains a separate Shufflrr connection per verified Clerk app session, until logout or that session's actual expiry, rather than expiring it after five minutes. The first connection requires Clerk Backend API session lookup using the existing server-only Clerk key; failures return a safe error rather than bypassing validation. Local session connections are bounded to 256 per instance, never persisted, and discarded on graceful shutdown. Reauthentication after provider expiry, instance changes, or process restart is expected and does not require sticky sessions. Deploy frontend and API changes together so header logout can discard its server connection before Clerk signs out. No new variables or migration are required.

# Deployment

The production API serves the compiled SharePoint viewer and `/api` routes from one stateless Node.js process, binding to `0.0.0.0` on the host-provided `PORT`. Sync uses a separate worker process and durable PostgreSQL state.

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

The SharePoint viewer and all SharePoint API routes require a valid Clerk session. `/healthz` remains public for platform health checks; `/api/auth/config` returns only the Clerk publishable key. Configure the deployed domain and email/password sign-in in Clerk. Any signed-in user can change the shared sync configuration. The worker polls once per minute, does not use a browser session, and exits cleanly on shutdown. A PostgreSQL advisory lock prevents overlapping runs across worker instances.

Railway Cron Jobs run no more often than every five minutes, so they cannot provide the selected one-minute polling interval. Use the always-on worker service above; it consumes worker resources while running. The worker does nothing when sync is paused.

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
