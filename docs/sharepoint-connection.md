# Connect to Microsoft SharePoint using three variables

Use Microsoft Graph with **application credentials**. Run all credential and token operations on the server, never in browser code.

## 1. Required variables

| Variable | Value |
|---|---|
| `MICROSOFT_TENANT_ID` | The **Directory (tenant) ID** of the Microsoft Entra tenant that owns the SharePoint site. |
| `MICROSOFT_CLIENT_ID` | The **Application (client) ID** of the Microsoft Entra app registration. Do not use the application's Object ID. |
| `MICROSOFT_CLIENT_SECRET` | The client secret **Value** created under the app registration's **Certificates & secrets**. Do not use the Secret ID. |

Store these as server-side secrets:

```dotenv
MICROSOFT_TENANT_ID=your-directory-tenant-id
MICROSOFT_CLIENT_ID=your-application-client-id
MICROSOFT_CLIENT_SECRET=your-client-secret-value
```

The app registration needs Microsoft Graph **Application permissions**, not just Delegated permissions.

For access limited to a particular SharePoint site:

1. Add the Microsoft Graph application permission `Sites.Selected`.
2. Have an administrator grant consent.
3. Have an administrator explicitly grant that application access to the intended site, using the `read` role for browsing.

**Admin consent alone does not grant site access when using `Sites.Selected`.** A valid access token also does not prove the application has permission to read the target site.

## 2. Exchange the variables for an access token

Send this server-side request:

```http
POST https://login.microsoftonline.com/{MICROSOFT_TENANT_ID}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id={MICROSOFT_CLIENT_ID}
client_secret={MICROSOFT_CLIENT_SECRET}
grant_type=client_credentials
scope=https://graph.microsoft.com/.default
```

Form-encode the values; do not send this payload as JSON.

### Node.js / TypeScript example

This example uses built-in `fetch`:

```ts
export async function getSharePointAccessToken(): Promise<string> {
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Required Microsoft connection variables are missing.");
  }

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    },
  );

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!response.ok || typeof data.access_token !== "string" || !data.access_token) {
    // Do not expose the raw identity-provider response or supplied credentials.
    throw new Error("Microsoft application authentication failed.");
  }

  return data.access_token;
}
```

For repeated requests, cache the token server-side until shortly before the response's `expires_in` deadline, then request another token using the same three variables. This flow does not issue a refresh token.

## 3. Use the token to call Microsoft Graph

Add this header to server-side Microsoft Graph requests:

```http
Authorization: Bearer {access_token}
```

For example, resolve a SharePoint site from its hostname and site path:

```http
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}
Authorization: Bearer {access_token}
Accept: application/json
```

For a site URL such as `https://contoso.sharepoint.com/sites/KnowledgeBase`, the request is:

```http
GET https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/KnowledgeBase
```

Use the returned site ID in subsequent Graph calls, such as:

```http
GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives
```

The **three variables authenticate the application**. The intended SharePoint site or folder URL must still be supplied separately to identify which content to access; it cannot be inferred from these credentials.

## Connection failures

- **Token request fails:** check the tenant ID, application client ID, secret Value, and secret expiration.
- **Graph returns 403:** check application permissions, admin consent, and the explicit target-site grant.
- **Graph returns 404:** verify the target site/path and permissions; inaccessible resources may appear as not found.

Never log or return the client secret or access token. These endpoint examples apply to Microsoft 365's public cloud.

## Microsoft references

- [Client credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow)
- [Selected permissions and explicit resource grants](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)
- [Resolve a SharePoint site by path](https://learn.microsoft.com/en-us/graph/api/site-getbypath?view=graph-rest-1.0)
