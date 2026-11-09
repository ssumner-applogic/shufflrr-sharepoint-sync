# Shufflrr-SharePoint Sync Agent

A sign-in-protected SharePoint document browser and access diagnostic. The server uses Microsoft app-only credentials; the browser never receives those credentials or Graph access tokens. Clerk handles user sign-in.

## Local setup

1. Install Node.js 24 and pnpm 10.26.1.
2. Run `pnpm install --frozen-lockfile`.
3. Set these values in the workspace's secret manager:
   - Clerk: `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
   - Microsoft Graph: `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, and `MICROSOFT_CLIENT_SECRET`.
   - Optionally `SESSION_SECRET` for signing pagination cursors independently of the Microsoft client secret.
4. Start the Replit-managed API and web workflows.

The Clerk publishable key is served to the web app by `/api/auth/config`; it is public by design. The Clerk secret key and Microsoft credentials remain server-only. Email/password sign-in and whether users can sign up are controlled by the selected Clerk application's settings.

Useful commands:

- `pnpm run typecheck` — check all workspace packages.
- `pnpm run build` — production-build the SharePoint web app and API.
- `pnpm start` — run the combined production server. It uses `PORT` supplied by the host.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for Railway and Google Cloud Run setup, health checks, and production secrets.

## Shufflrr API validator (standalone CLI)

This operator-only, read-only tool signs in with a dedicated **Shufflrr service account**, then recursively lists the folders and files visible to that account. It is independent of Clerk and does not yet populate the Shufflrr Viewer tab.

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
