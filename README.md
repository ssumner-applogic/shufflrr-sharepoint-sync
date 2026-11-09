# Shufflrr-SharePoint Sync Agent

A SharePoint document browser and access diagnostic. The server uses Microsoft app-only credentials; the browser never receives those credentials or Graph access tokens.

## Local setup

1. Install Node.js 24 and pnpm 10.26.1.
2. Run `pnpm install --frozen-lockfile`.
3. Set the required Microsoft credentials in the workspace's secret manager: `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, and `MICROSOFT_CLIENT_SECRET`.
4. Start the Replit-managed API and web workflows.

Useful commands:

- `pnpm run typecheck` — check all workspace packages.
- `pnpm run build` — production-build the SharePoint web app and API.
- `pnpm start` — run the combined production server. It uses `PORT` supplied by the host.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for Railway and Google Cloud Run setup, health checks, and production secrets.
