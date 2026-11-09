# Deployment

The production container serves the compiled SharePoint viewer and `/api` routes from one stateless Node.js process. It binds to `0.0.0.0` using the host-provided `PORT`; it does not depend on Replit-only services or local persistence.

## Railway

1. Connect the repository and deploy from the repository root. Railway will use the root `Dockerfile`.
2. Add these server-side service variables in the Railway production environment:
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
   - `MICROSOFT_TENANT_ID`
   - `MICROSOFT_CLIENT_ID`
   - `MICROSOFT_CLIENT_SECRET`
   - Optionally `SESSION_SECRET` for signing pagination cursors independently of the Microsoft client secret.
3. Set the health check path to `/healthz`.
4. Deploy the service. The Docker image builds the frontend and API, then runs the compiled API server. Railway supplies `PORT`.

The SharePoint viewer and all SharePoint API routes require a valid Clerk session. `/healthz` remains public for platform health checks; `/api/auth/config` returns only the Clerk publishable key. Add the production Clerk key pair from the selected Clerk application to Railway variables, and configure the deployed domain and email/password sign-in in that Clerk application. Control account creation in Clerk settings. Any authenticated app user can browse the configured library, so keep the Microsoft application grant limited to the intended site. The access test requires write permission because it creates and removes a temporary probe file.

## Google Cloud Run

Use the same Dockerfile. Provide Clerk and Microsoft variables through Secret Manager and map them to the container environment. Cloud Run supplies `PORT`; configure `/healthz` as the health check. The application is stateless and needs no database migration.

## Local production smoke test

```sh
pnpm install --frozen-lockfile
pnpm run build
PORT=8080 pnpm start
```

Then check `GET /healthz` and `GET /api/sharepoint/status`.
The SharePoint status endpoint returns `401` without a Clerk session. `GET /api/auth/config` is public and returns only the publishable key needed to initialize the Clerk browser SDK.
