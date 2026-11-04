import { createHmac, timingSafeEqual } from "node:crypto";
import type { AccessReport, FolderListing } from "@workspace/api-zod";

export const libraryUrl = "https://sandvine.sharepoint.com/sites/ApplogicKnowledgeBase/Shared%20Documents";
const graphRoot = "https://graph.microsoft.com/v1.0";
interface GraphItem {
  id: string;
  name: string;
  webUrl: string;
  folder?: unknown;
  size?: number;
  lastModifiedDateTime?: string;
}
interface GraphPage { value: GraphItem[]; "@odata.nextLink"?: string }
const keys = ["MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"] as const;
export const missingCredentials = () => keys.filter(key => !process.env[key]);
export const productionBlocked = () => process.env.NODE_ENV !== "development";

export class AccessError extends Error {
  constructor(public code: string, message: string, public status = 502, public requestId?: string) {
    super(message);
  }
}

export function advice(error: AccessError): string[] {
  if (error.code === "InvalidClientSecret") return ["Replace MICROSOFT_CLIENT_SECRET with the current secret Value (not the Secret ID) from this app registration. Check that it has not expired."];
  if (error.code === "InvalidTenant") return ["Confirm MICROSOFT_TENANT_ID is the Directory (tenant) ID of the organization hosting this SharePoint site."];
  if (error.code === "InvalidClient") return ["Confirm MICROSOFT_CLIENT_ID is the Application (client) ID in that tenant, not the Object ID."];
  if (error.code === "MissingCredentials") return ["Add the missing Microsoft credentials in Replit Secrets, then restart the API server."];
  if (error.status === 403 || error.code === "accessDenied") return [
    "Ask a Microsoft 365 administrator to check Microsoft Graph APPLICATION permissions and admin consent for this app.",
    "Recommended: Sites.Selected plus an explicit read grant to /sites/ApplogicKnowledgeBase. Admin consent alone does not grant site access.",
    "If the app already has broad application access (Files.Read.All or Sites.Read.All), verify admin consent and any tenant restrictions. No user password is needed.",
  ];
  if (error.status === 404) return ["Confirm the site and library URL. Microsoft can also hide inaccessible resources as not found; ask the administrator to verify the app's site read grant."];
  if (error.code === "LibraryNotFound") return ["Confirm the document library URL or provide its drive ID. The site was resolved, but no library matched Shared Documents."];
  if (error.code === "ProductionBlocked") return ["This prototype only exposes SharePoint data in development. Add application-level sign-in and authorization before publishing."];
  if (error.status === 429) return ["Microsoft throttled the request. Wait before retrying."];
  return ["Review the failed step and Microsoft error code. If permissions are delegated only, configure application permissions for this app-only connection."];
}

let tokenCache: { value: string; expires: number; roles: string[] } | undefined;
async function token() {
  if (missingCredentials().length) throw new AccessError("MissingCredentials", "Required Microsoft credentials are missing.");
  if (tokenCache && tokenCache.expires > Date.now()) return tokenCache;
  const tenant = process.env.MICROSOFT_TENANT_ID!;
  if (!/^[a-zA-Z0-9.-]+$/.test(tenant)) throw new AccessError("InvalidTenant", "Tenant ID has an invalid format.");
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST", signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default",
    }),
  });
  const data = await res.json() as { access_token?: string; expires_in?: number; error_codes?: number[]; error?: string };
  if (!res.ok || !data.access_token) {
    const codes: number[] = data.error_codes || [];
    const code = codes.includes(7000215) || codes.includes(7000222) ? "InvalidClientSecret"
      : codes.includes(90002) ? "InvalidTenant" : codes.includes(700016) ? "InvalidClient" : String(data.error || "TokenRequestFailed");
    // Never return the raw identity response: it can echo supplied credentials.
    throw new AccessError(code, `Microsoft authentication failed (${codes.map(c => `AADSTS${c}`).join(", ") || code}).`, res.status);
  }
  let roles: string[] = [];
  try {
    const claims = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64url").toString());
    roles = Array.isArray(claims.roles) ? claims.roles.filter((r: unknown) => typeof r === "string") : [];
  } catch { /* Opaque tokens are valid; roles are informational, not authorization. */ }
  tokenCache = { value: data.access_token, expires: Date.now() + Math.max(0, Number(data.expires_in) - 120) * 1000, roles };
  return tokenCache;
}

async function graph<T = GraphPage>(path: string): Promise<T> {
  const auth = await token();
  const url = path.startsWith("https:") ? new URL(path) : new URL(graphRoot + path);
  if (url.origin !== "https://graph.microsoft.com" || !url.pathname.startsWith("/v1.0/")) {
    throw new AccessError("InvalidCursor", "Invalid Microsoft Graph continuation URL.", 400);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${auth.value}` }, signal: AbortSignal.timeout(20000), redirect: "error" });
  const data = await res.json() as T & { error?: { code?: string } };
  if (!res.ok) {
    if (res.status === 401) tokenCache = undefined;
    throw new AccessError(String(data.error?.code || "GraphError"),
      `Microsoft Graph returned HTTP ${res.status}: ${String(data.error?.code || "request failed")}.`,
      res.status, res.headers.get("request-id") || undefined);
  }
  return data;
}

let locationCache: { siteId: string; driveId: string; expires: number } | undefined;
async function site() {
  return graph<{ id: string }>("/sites/sandvine.sharepoint.com:/sites/ApplogicKnowledgeBase?$select=id,displayName,webUrl");
}
async function library(siteId: string) {
  let path: string | undefined = `/sites/${encodeURIComponent(siteId)}/drives?$select=id,name,webUrl`;
  while (path) {
    const page: GraphPage = await graph(path);
    const drive = page.value?.find((d: { webUrl?: string }) =>
      d.webUrl && decodeURIComponent(d.webUrl).replace(/\/$/, "").toLowerCase() === decodeURIComponent(libraryUrl).toLowerCase());
    if (drive) {
      locationCache = { siteId, driveId: drive.id, expires: Date.now() + 300000 };
      return drive;
    }
    path = page["@odata.nextLink"];
  }
  throw new AccessError("LibraryNotFound", "The site is accessible but the Shared Documents library could not be found.");
}
async function location() {
  if (locationCache && locationCache.expires > Date.now()) return locationCache;
  await library((await site()).id);
  return locationCache!;
}

function sign(value: string) {
  return createHmac("sha256", process.env.SESSION_SECRET || process.env.MICROSOFT_CLIENT_SECRET!).update(value).digest("base64url");
}
function cursorFor(url: string, driveId: string) {
  const payload = Buffer.from(JSON.stringify({ url, driveId, expires: Date.now() + 3600000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readCursor(cursor: string, driveId: string, expectedPath: string) {
  try {
    const [payload, signature] = cursor.split(".");
    const expected = Buffer.from(sign(payload!));
    const received = Buffer.from(signature || "");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error();
    const parsed = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const url = new URL(parsed.url);
    if (parsed.driveId !== driveId || parsed.expires < Date.now() ||
      url.origin !== "https://graph.microsoft.com" || url.pathname !== expectedPath) throw new Error();
    return url.toString();
  } catch { throw new AccessError("InvalidCursor", "Pagination expired or is invalid. Refresh the folder.", 400); }
}

export async function listFolder(folderId?: string, cursor?: string): Promise<FolderListing> {
  const { driveId } = await location();
  const segment = folderId ? `items/${encodeURIComponent(folderId)}` : "root";
  const path = `/drives/${encodeURIComponent(driveId)}/${segment}/children`;
  const page = await graph(cursor
    ? readCursor(cursor, driveId, `/v1.0${path}`)
    : `${path}?$select=id,name,folder,size,lastModifiedDateTime,webUrl&$top=200`);
  return {
    items: page.value.map((item: { id: string; name: string; folder?: unknown; size?: number; lastModifiedDateTime?: string; webUrl?: string }) => ({
      id: item.id, name: item.name, isFolder: !!item.folder, size: item.size || 0,
      modifiedAt: item.lastModifiedDateTime || "", webUrl: item.webUrl || "",
    })),
    ...(page["@odata.nextLink"] ? { nextCursor: cursorFor(page["@odata.nextLink"], driveId) } : {}),
  };
}

export function normalizeError(error: unknown) {
  return error instanceof AccessError ? error : new AccessError("NetworkError", "Could not complete the Microsoft request. Check network availability and retry.");
}

export async function testAccess(): Promise<AccessReport> {
  const report: AccessReport = { ok: false, checkedAt: new Date().toISOString(), steps: [], advice: [], permissions: [] };
  const names = ["Authenticate application", "Resolve SharePoint site", "Resolve document library", "List files and folders"];
  const operations = [
    async () => {
      tokenCache = undefined; locationCache = undefined;
      const auth = await token(); report.permissions = auth.roles;
      return "Microsoft accepted the application credentials.";
    },
    async () => { const found = await site(); locationCache = { siteId: found.id, driveId: "", expires: 0 }; return "Target SharePoint site is accessible."; },
    async () => { await library(locationCache!.siteId); return "Shared Documents library is accessible."; },
    async () => { const page = await listFolder(); return `Read ${page.items.length} items from the library root${page.nextCursor ? " (additional pages available)" : ""}.`; },
  ];
  for (let i = 0; i < names.length; i++) {
    try {
      if (productionBlocked()) throw new AccessError("ProductionBlocked", "Access is disabled outside development until app-level authentication is added.", 503);
      report.steps.push({ name: names[i]!, status: "passed", message: await operations[i]!() });
    } catch (err) {
      const e = normalizeError(err);
      report.steps.push({ name: names[i]!, status: "failed", message: e.message, code: e.code, requestId: e.requestId });
      for (const name of names.slice(i + 1)) report.steps.push({ name, status: "skipped", message: "Waiting for the previous step to succeed." });
      report.advice = advice(e);
      return report;
    }
  }
  report.ok = true;
  report.advice = ["Access confirmed. No additional Microsoft user credentials are required.", "Keep this development prototype private. Add app-level authentication and authorization before publishing."];
  return report;
}
