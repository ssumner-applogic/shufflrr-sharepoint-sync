# Shufflrr-SharePoint Sync Agent

A SharePoint document browser and access diagnostic. The write-access check creates and removes a uniquely named temporary file in the configured library.

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
- The user requested a minimal document viewer with real access testing and actionable information about missing configuration. The final access check briefly creates and removes a uniquely named temporary file to verify effective write access.
- SharePoint access uses server-side Microsoft app-only credentials. Anyone who can reach the published viewer can browse the target Shared Documents library; keep the app registration restricted to the intended site and store credentials only in server-side secrets.

## Product

Test Microsoft credentials, resolve the site and library, list root files and folders, verify read and write access, navigate folders, and follow paginated results. The write check removes its temporary file. Credentials and access tokens remain server-side.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
