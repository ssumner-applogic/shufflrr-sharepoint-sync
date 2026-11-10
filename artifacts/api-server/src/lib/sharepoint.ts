import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { AccessReport, FolderListing } from "@workspace/api-zod";

export const libraryUrl = "https://sandvine.sharepoint.com/sites/ApplogicKnowledgeBase/Shared%20Documents";
const graphRoot = "https://graph.microsoft.com/v1.0";
interface GraphItem {
  id: string;
  name: string;
  webUrl?: string;
  folder?: unknown;
  size?: number;
  cTag?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  parentReference?: { id?: string };
}
interface GraphPage { value: GraphItem[]; "@odata.nextLink"?: string }
const keys = ["MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"] as const;
export const missingCredentials = () => keys.filter(key => !process.env[key]);

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
  if (error.code === "WriteAccessDenied") return [
    "Read access is available, but the application cannot write to this library.",
    "Ask a Microsoft 365 administrator to grant this app write access to the SharePoint site. For Sites.Selected, the site grant must include write access.",
  ];
  if (error.code === "WriteProbeCleanupFailed") return ["The temporary write-test file may still be in Shared Documents. Check the file name in the error and remove it before retrying."];
  if (error.status === 403 || error.code === "accessDenied") return [
    "Ask a Microsoft 365 administrator to check Microsoft Graph APPLICATION permissions and admin consent for this app.",
    "Recommended: Sites.Selected plus an explicit read grant to /sites/ApplogicKnowledgeBase. Admin consent alone does not grant site access.",
    "If the app already has broad application access (Files.Read.All or Sites.Read.All), verify admin consent and any tenant restrictions. No user password is needed.",
  ];
  if (error.status === 404) return ["Confirm the site and library URL. Microsoft can also hide inaccessible resources as not found; ask the administrator to verify the app's site read grant."];
  if (error.code === "LibraryNotFound") return ["Confirm the document library URL or provide its drive ID. The site was resolved, but no library matched Shared Documents."];
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

async function graph<T = GraphPage>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = await token();
  const url = path.startsWith("https:") ? new URL(path) : new URL(graphRoot + path);
  if (url.origin !== "https://graph.microsoft.com" || !url.pathname.startsWith("/v1.0/")) {
    throw new AccessError("InvalidCursor", "Invalid Microsoft Graph continuation URL.", 400);
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${auth.value}`);
  const res = await fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(20000),
    redirect: "error",
  });
  const data = res.status === 204 ? undefined : await res.json() as T & { error?: { code?: string } };
  if (!res.ok) {
    if (res.status === 401) tokenCache = undefined;
    const code = data?.error?.code || "GraphError";
    throw new AccessError(String(code),
      `Microsoft Graph returned HTTP ${res.status}: ${String(code || "request failed")}.`,
      res.status, res.headers.get("request-id") || undefined);
  }
  return data as T;
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

function validateItemName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 255 ||
    !name.trim() ||
    /[\\/\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new AccessError("InvalidName", "Enter a valid SharePoint name (1–255 characters, without slashes or control characters).", 400);
  }
}

function itemResult(item: GraphItem) {
  return {
    id: item.id,
    name: item.name,
    isFolder: !!item.folder,
    size: item.size || 0,
    modifiedAt: item.lastModifiedDateTime || "",
    webUrl: item.webUrl || "",
  };
}

async function getDriveItem(driveId: string, itemId: string): Promise<GraphItem> {
  return graph<GraphItem>(
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=id,name,folder,size,lastModifiedDateTime,webUrl,parentReference,cTag,eTag`,
  );
}

async function getRootId(driveId: string): Promise<string> {
  const root = await graph<{ id: string }>(`/drives/${encodeURIComponent(driveId)}/root?$select=id`);
  return root.id;
}

export async function createSharePointFolder(name: string, parentId?: string | null) {
  validateItemName(name);
  const { driveId } = await location();
  const rootId = await getRootId(driveId);
  const resolvedParentId = parentId ?? rootId;
  const parent = resolvedParentId === rootId
    ? await getDriveItem(driveId, rootId)
    : await getDriveItem(driveId, resolvedParentId);
  if (!parent.folder) {
    throw new AccessError("InvalidDestination", "Choose a SharePoint folder as the destination.", 400);
  }

  const created = await graph<GraphItem>(
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(resolvedParentId)}/children`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );
  return itemResult(created);
}

export async function updateSharePointItem(
  itemId: string,
  update: { name?: string; parentId?: string | null },
) {
  if (update.name !== undefined) validateItemName(update.name);
  if (update.name === undefined && update.parentId === undefined) {
    throw new AccessError("InvalidUpdate", "Provide a new name or destination folder.", 400);
  }

  const { driveId } = await location();
  const rootId = await getRootId(driveId);
  const item = await getDriveItem(driveId, itemId);
  if (item.id === rootId || !item.parentReference?.id) {
    throw new AccessError("ProtectedRoot", "The library root cannot be renamed or moved.", 400);
  }

  const body: { name?: string; parentReference?: { id: string } } = {};
  if (update.name !== undefined) body.name = update.name;
  if (update.parentId !== undefined) {
    const destinationId = update.parentId ?? rootId;
    if (destinationId === item.parentReference.id && update.name === undefined) {
      return itemResult(item);
    }
    const destination = destinationId === rootId
      ? await getDriveItem(driveId, rootId)
      : await getDriveItem(driveId, destinationId);
    if (!destination.folder) {
      throw new AccessError("InvalidDestination", "Choose a SharePoint folder as the destination.", 400);
    }

    if (item.folder) {
      let currentId: string | undefined = destinationId;
      let reachedRoot = false;
      for (let depth = 0; currentId && depth <= 100; depth++) {
        if (currentId === item.id) {
          throw new AccessError("InvalidDestination", "A folder cannot be moved into itself or one of its subfolders.", 400);
        }
        if (currentId === rootId) {
          reachedRoot = true;
          break;
        }
        const ancestor = await getDriveItem(driveId, currentId);
        currentId = ancestor.parentReference?.id;
        if (!currentId) {
          throw new AccessError("InvalidDestination", "The destination folder hierarchy could not be verified.", 400);
        }
      }
      if (!reachedRoot) {
        throw new AccessError("InvalidDestination", "The destination folder hierarchy could not be verified.", 400);
      }
    }
    body.parentReference = { id: destinationId };
  }

  const updated = await graph<GraphItem>(
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  return itemResult(updated);
}

export async function deleteSharePointItem(itemId: string): Promise<void> {
  const { driveId } = await location();
  const rootId = await getRootId(driveId);
  const item = await getDriveItem(driveId, itemId);
  if (item.id === rootId || !item.parentReference?.id) {
    throw new AccessError("ProtectedRoot", "The library root cannot be deleted.", 400);
  }
  await graph<void>(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

export interface SyncDriveItem {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  modifiedAt: string;
  cTag?: string;
  parentId?: string;
}

function syncDriveItem(item: GraphItem): SyncDriveItem {
  return {
    id: item.id,
    name: item.name,
    isFolder: !!item.folder,
    size: item.size ?? 0,
    modifiedAt: item.lastModifiedDateTime ?? "",
    ...(item.cTag ? { cTag: item.cTag } : {}),
    ...(item.parentReference?.id ? { parentId: item.parentReference.id } : {}),
  };
}

export async function getSyncDriveItem(itemId: string): Promise<SyncDriveItem> {
  const { driveId } = await location();
  if (itemId === "root") {
    const rootId = await getRootId(driveId);
    return syncDriveItem(await getDriveItem(driveId, rootId));
  }
  return syncDriveItem(await getDriveItem(driveId, itemId));
}

export async function listSyncFolder(folderId: string): Promise<SyncDriveItem[]> {
  const { driveId } = await location();
  const resolvedId = folderId === "root" ? await getRootId(driveId) : folderId;
  const folder = await getDriveItem(driveId, resolvedId);
  if (!folder.folder) throw new AccessError("InvalidDestination", "The configured SharePoint destination is not a folder.", 400);

  const result: SyncDriveItem[] = [];
  let next: string | undefined =
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(resolvedId)}/children?$select=id,name,folder,size,lastModifiedDateTime,webUrl,parentReference,cTag,eTag&$top=200`;
  let pages = 0;
  while (next) {
    if (++pages > 1000 || result.length > 100_000) {
      throw new AccessError("SyncLimit", "The SharePoint folder exceeded the sync safety limit.", 413);
    }
    const page: GraphPage = await graph<GraphPage>(next);
    if (!Array.isArray(page.value)) throw new AccessError("GraphSchema", "SharePoint returned an unexpected folder listing.");
    result.push(...page.value.map(syncDriveItem));
    next = page["@odata.nextLink"];
  }
  return result;
}

export async function createSyncFolder(parentId: string, name: string): Promise<SyncDriveItem> {
  const created = await createSharePointFolder(name, parentId === "root" ? null : parentId);
  return getSyncDriveItem(created.id);
}

export async function updateSyncItem(
  itemId: string,
  update: { name: string; parentId: string },
): Promise<SyncDriveItem> {
  await updateSharePointItem(itemId, {
    name: update.name,
    parentId: update.parentId === "root" ? null : update.parentId,
  });
  return getSyncDriveItem(itemId);
}

export async function uploadSyncFile(
  parentId: string,
  name: string,
  bytes: Uint8Array,
  existingId?: string,
): Promise<SyncDriveItem> {
  validateItemName(name);
  if (bytes.byteLength > 100 * 1024 * 1024) {
    throw new AccessError("SyncLimit", "Files larger than 100 MiB are not supported by this sync.", 413);
  }
  const { driveId } = await location();
  const resolvedParentId = parentId === "root" ? await getRootId(driveId) : parentId;
  const path = existingId
    ? `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(existingId)}/content`
    : `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(resolvedParentId)}:/${encodeURIComponent(name)}:/content`;
  try {
    const item = await graph<GraphItem>(path, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(existingId ? {} : { "If-None-Match": "*" }),
      },
      body: bytes,
    });
    return syncDriveItem(item);
  } catch (error) {
    if (!existingId && error instanceof AccessError && error.status === 412) {
      throw new AccessError("SyncConflict", "A SharePoint item appeared at this path during sync; it was left unchanged.", 409);
    }
    throw error;
  }
}

export async function deleteSyncItem(itemId: string): Promise<void> {
  await deleteSharePointItem(itemId);
}

async function findWriteProbe(driveId: string, fileName: string): Promise<string | undefined> {
  try {
    const item = await graph<{ id?: string }>(
      `/drives/${encodeURIComponent(driveId)}/root:/${encodeURIComponent(fileName)}?$select=id`,
    );
    return item.id;
  } catch (error) {
    if (error instanceof AccessError && error.status === 404) return undefined;
    throw error;
  }
}

async function deleteWriteProbe(driveId: string, itemId: string, fileName: string): Promise<void> {
  const path = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await graph<void>(path, { method: "DELETE" });
      return;
    } catch (error) {
      if (error instanceof AccessError && error.status === 404) return;
      lastError = error;
    }
  }
  const cleanup = normalizeError(lastError);
  throw new AccessError(
    "WriteProbeCleanupFailed",
    `Write access succeeded, but the temporary file "${fileName}" could not be removed. Remove it from Shared Documents.`,
    cleanup.status,
    cleanup.requestId,
  );
}

async function verifyWriteAccess(): Promise<string> {
  const { driveId } = await location();
  const fileName = `Shufflrr-SharePoint-Write-Test-${randomUUID()}.txt`;
  const drivePath = `/drives/${encodeURIComponent(driveId)}`;
  let itemId: string | undefined;

  try {
    const item = await graph<{ id?: string }>(
      `${drivePath}/root:/${encodeURIComponent(fileName)}:/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Temporary SharePoint write-access probe. Safe to delete.",
      },
    );
    itemId = item.id;
  } catch (error) {
    if (error instanceof AccessError) {
      if (error.status === 403 || error.code === "accessDenied") {
        throw new AccessError("WriteAccessDenied", error.message, error.status, error.requestId);
      }
      throw error;
    }

    try {
      itemId = await findWriteProbe(driveId, fileName);
    } catch (lookupError) {
      const lookup = normalizeError(lookupError);
      throw new AccessError(
        "WriteProbeCleanupFailed",
        `The upload result is unclear. Check Shared Documents for "${fileName}" and remove it if present.`,
        lookup.status,
        lookup.requestId,
      );
    }
    if (itemId) await deleteWriteProbe(driveId, itemId, fileName);
    throw error;
  }

  if (!itemId) {
    try {
      itemId = await findWriteProbe(driveId, fileName);
    } catch (error) {
      const lookup = normalizeError(error);
      throw new AccessError(
        "WriteProbeCleanupFailed",
        `SharePoint did not return the temporary file ID. Check Shared Documents for "${fileName}" and remove it if present.`,
        lookup.status,
        lookup.requestId,
      );
    }
  }
  if (!itemId) {
    throw new AccessError(
      "WriteProbeCleanupFailed",
      `SharePoint did not return an ID for "${fileName}". Check Shared Documents and remove it if present.`,
    );
  }
  await deleteWriteProbe(driveId, itemId, fileName);
  return "Temporary probe file created and removed.";
}

export function normalizeError(error: unknown) {
  return error instanceof AccessError ? error : new AccessError("NetworkError", "Could not complete the Microsoft request. Check network availability and retry.");
}

export async function testAccess(): Promise<AccessReport> {
  const report: AccessReport = { ok: false, checkedAt: new Date().toISOString(), steps: [], advice: [], permissions: [] };
  const names = ["Authenticate application", "Resolve SharePoint site", "Resolve document library", "List files and folders", "Verify write access"];
  const operations = [
    async () => {
      tokenCache = undefined; locationCache = undefined;
      const auth = await token(); report.permissions = auth.roles;
      return "Microsoft accepted the application credentials.";
    },
    async () => { const found = await site(); locationCache = { siteId: found.id, driveId: "", expires: 0 }; return "Target SharePoint site is accessible."; },
    async () => { await library(locationCache!.siteId); return "Shared Documents library is accessible."; },
    async () => { const page = await listFolder(); return `Read ${page.items.length} items from the library root${page.nextCursor ? " (additional pages available)" : ""}.`; },
    async () => verifyWriteAccess(),
  ];
  for (let i = 0; i < names.length; i++) {
    try {
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
  report.advice = ["Read and write access confirmed. The temporary write-test file was removed.", "The Microsoft app credentials authorize access to this library; anyone who can reach the published viewer can browse it."];
  return report;
}
