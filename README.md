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
