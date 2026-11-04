# SharePoint Library Browser

A minimal read-only browser and access diagnostic for the configured SharePoint document library.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secrets: `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (secret Value, not Secret ID).
- `pnpm --filter @workspace/sharepoint-browser run dev` — frontend (use the managed workflow).
- No database is used by this application.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- This is an app-only Microsoft Graph client; do not replace it with delegated user OAuth without discussing the change.
- The user requested the simplest possible read-only application, with real access testing and actionable information about missing configuration.
- SharePoint data endpoints are disabled outside development until app-level authentication and authorization are added. This prevents an accidental publish from exposing organizational files.

## Product

Test Microsoft credentials, resolve the site and library, list root files and folders, navigate folders, and follow paginated results. Credentials and access tokens remain server-side.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
