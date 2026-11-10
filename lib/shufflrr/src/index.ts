import { randomUUID } from "node:crypto";
import { CookieJar } from "tough-cookie";
import { ProviderBackoffError, ProviderGate, requestSpacing } from "./http-policy";

const requestGate = new ProviderGate("Shufflrr", requestSpacing(process.env.SHUFFLRR_REQUEST_INTERVAL_MS));

export class ShufflrrError extends Error {
  constructor(
    public readonly code: "configuration" | "authentication" | "permission" | "http" | "network" | "schema" | "limit" | "throttled",
    message: string,
    public readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "ShufflrrError";
  }
}
export interface Entry {
  id: number;
  name: string;
  isFolder: boolean;
  userPermissions?: string | number;
  size?: number;
  modifiedAt?: string;
}
export interface RequestEvent {
  requestId: string;
  method: string;
  route: string;
  status?: number;
  durationMs: number;
}
export interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
  transport?: typeof fetch;
  onRequest?: (event: RequestEvent) => void;
}
export function validateBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new ShufflrrError("configuration", "SHUFFLRR_API_BASE_URL must be an HTTPS Shufflrr portal URL ending in /api.");
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.shufflrr\.com$/i.test(url.hostname) ||
    url.username || url.password || url.port || url.search || url.hash || !/^\/api\/?$/.test(url.pathname)
  ) {
    throw new ShufflrrError("configuration", "SHUFFLRR_API_BASE_URL must use your portal's HTTPS shufflrr.com host and /api path, without credentials, query parameters, or a custom port.");
  }
  return url.origin + "/api";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseEntries(value: unknown, foldersOnly = false): Entry[] {
  if (!Array.isArray(value)) throw new ShufflrrError("schema", "Unexpected API response: expected an array of folder/file records.");
  if (value.length > 100_000) throw new ShufflrrError("limit", "API response exceeded the 100,000-record safety limit.");
  const keys = new Set<string>();
  return value.map((item: unknown): Entry => {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id < 0 ||
      typeof item.name !== "string" || item.name.length === 0 ||
      typeof item.isFolder !== "boolean" || (foldersOnly && !item.isFolder) ||
      (item.userPermissions != null && typeof item.userPermissions !== "string" &&
        !(typeof item.userPermissions === "number" && Number.isSafeInteger(item.userPermissions))) ||
      (item.size != null && (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0)) ||
      (item.modifiedDate != null && typeof item.modifiedDate !== "string")
    ) throw new ShufflrrError("schema", "Unexpected API response: invalid folder/file record. Check the portal's API schema.");
    const key = `${item.isFolder}:${item.id}`;
    if (keys.has(key)) throw new ShufflrrError("schema", "API returned duplicate folder/file records.");
    keys.add(key);
    return {
      id: item.id, name: item.name, isFolder: item.isFolder,
      ...(item.userPermissions == null ? {} : { userPermissions: item.userPermissions as string | number }),
      ...(item.size == null ? {} : { size: item.size as number }),
      ...(item.modifiedDate == null ? {} : { modifiedAt: item.modifiedDate as string }),
    };
  });
}

// Server-only; no cookies or login identity are ever serialized.
export class ShufflrrClient {
  private readonly jar = new CookieJar();
  private readonly baseUrl: string;
  private readonly transport: typeof fetch;
  private authenticated = false;
  private identity?: { id: string; portalId: number };

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    this.transport = options.transport ?? fetch;
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)
      throw new ShufflrrError("configuration", "Request timeout must be between 1 and 120000 milliseconds.");
  }

  private async send(path: string, route: string, method = "GET", body?: unknown): Promise<Response> {
    const url = this.baseUrl + path;
    for (let attempt = 0; attempt < 3; attempt++) {
      const requestId = randomUUID();
      const started = performance.now();
      let status: number | undefined;
      try {
        const cookie = await this.jar.getCookieString(url);
        const multipart = body instanceof FormData;
        const response = await requestGate.request(() => this.transport(url, {
          method, redirect: "manual", signal: AbortSignal.timeout(this.options.timeoutMs),
          headers: {
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest", "X-Request-ID": requestId,
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body === undefined || multipart ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
        }), method, path !== "/account/login");
        status = response.status;
        for (const header of response.headers.getSetCookie()) await this.jar.setCookie(header, url);
        if (!response.ok) {
          await response.body?.cancel();
          if (status === 401) throw new ShufflrrError("authentication", "Authentication was rejected or the session expired.");
          if (status === 403) throw new ShufflrrError("permission", "Access denied. Check the service account's group and folder permissions.");
          if (status >= 300 && status < 400)
            throw new ShufflrrError("http", "API redirected the request. Redirects are blocked to protect credentials; verify the portal URL and authentication settings.");
          throw new ShufflrrError("http", `API request failed (HTTP ${status}).`);
        }
        return response;
      } catch (error) {
        if (error instanceof ProviderBackoffError) {
          throw new ShufflrrError("throttled", "Shufflrr requested a cooldown. Try again after the required delay.", error.retryAt);
        }
        if (error instanceof ShufflrrError) throw error;
        throw new ShufflrrError("network", "Request failed or timed out. Check connectivity, TLS, and the configured portal URL.");
      } finally {
        this.options.onRequest?.({ requestId, method, route, status, durationMs: Math.round(performance.now() - started) });
      }
    }
    throw new ShufflrrError("http", "API retry limit reached.");
  }

  private async request(path: string, route: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await this.send(path, route, method, body);
    if (response.status === 204) return undefined;
    if (!/application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      throw new ShufflrrError("schema", "API did not return JSON. Check the portal's API URL and authentication settings.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ShufflrrError("schema", "API returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 10 * 1024 * 1024) {
          await reader.cancel();
          throw new ShufflrrError("limit", "API response exceeded the 10 MiB safety limit.");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ShufflrrError) throw error;
      throw new ShufflrrError("network", "Request failed or timed out. Check connectivity, TLS, and the configured portal URL.");
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new ShufflrrError("schema", "API returned invalid JSON."); }
  }

  async login(emailAddress: string, password: string): Promise<void> {
    await this.close();
    const result = await this.request("/account/login", "/account/login", "POST", { emailAddress, password, keepLoggedIn: true });
    if (!isRecord(result) || typeof result.success !== "boolean")
      throw new ShufflrrError("schema", "Login returned an unexpected response; expected a success flag.");
    if (!result.success) throw new ShufflrrError("authentication", "Login failed. Check the service account credentials and portal access.");
    if (!(await this.jar.getCookieString(this.baseUrl + "/folders")))
      throw new ShufflrrError("authentication", "Login succeeded but no usable session cookie was returned.");
    if (isRecord(result.user) && typeof result.user.id === "string" &&
      typeof result.user.portalId === "number" && Number.isSafeInteger(result.user.portalId))
      this.identity = { id: result.user.id, portalId: result.user.portalId };
    this.authenticated = true;
  }

  private requireSession(): void {
    if (!this.authenticated) throw new ShufflrrError("authentication", "Sign in before requesting folders.");
  }
  async roots(): Promise<Entry[]> {
    this.requireSession();
    return parseEntries(await this.request("/folders", "/folders"), true);
  }
  async folder(id: number): Promise<Entry> {
    this.requireSession();
    if (!Number.isSafeInteger(id) || id < 1) throw new ShufflrrError("schema", "Invalid folder ID.");
    return parseEntries([await this.request(`/folders/${id}`, "/folders/{id}")], true)[0];
  }
  async contents(id: number): Promise<Entry[]> {
    this.requireSession();
    if (!Number.isSafeInteger(id) || id < 0) throw new ShufflrrError("schema", "Invalid folder ID.");
    return parseEntries(await this.request(`/folders/${id}/contents/false`, "/folders/{id}/contents/{includeDelete}"));
  }
  async file(id: number): Promise<Entry> {
    this.requireSession();
    return parseEntries([await this.request(`/files/${id}`, "/files/{id}")])[0];
  }
  async download(id: number): Promise<Response> {
    this.requireSession();
    return this.send(`/files/${id}/download`, "/files/{id}/download");
  }

  // Operator-only permission administration. No HTTP route exposes this method.
  async grantOwnFolderControl(id: number): Promise<Entry> {
    this.requireSession();
    if (!this.identity) throw new ShufflrrError("schema", "Login did not return the service identity required for permission administration.");
    if (!Number.isSafeInteger(id) || id < 1) throw new ShufflrrError("schema", "Invalid folder ID.");
    const folder = parseEntries([await this.request(`/folders/${id}/permissions`, "/folders/{id}/permissions", "POST", {
      principalIds: [this.identity.id], permission: "FullControl",
    })], true)[0];
    if (folder.id !== id || !String(folder.userPermissions).split(/,\s*/).includes("FullControl"))
      throw new ShufflrrError("permission", "The API did not confirm Full Control for this service account.");
    return folder;
  }

  // Mutation methods are used only by the isolated permission probe, not exposed as app CRUD endpoints.
  async createFolder(parentId: number, name: string): Promise<Entry> {
    this.requireSession();
    if (!this.identity) throw new ShufflrrError("schema", "Login did not return the service identity required for a folder probe.");
    const now = new Date().toISOString();
    const created = parseEntries([await this.request("/folders", "/folders", "POST", {
      id: 0, name, parentFolderId: parentId, fileType: "Folder", isFolder: true,
      portalId: this.identity.portalId, createdById: this.identity.id, modifiedById: this.identity.id,
      createdDate: now, modifiedDate: now, description: "Temporary Shufflrr access verification",
    })], true)[0];
    if (created.name !== name) throw new ShufflrrError("schema", "Created folder did not match the probe name.");
    return created;
  }
  async rename(id: number, name: string, folder: boolean): Promise<void> {
    this.requireSession();
    await this.request(folder ? "/folders" : "/files", folder ? "/folders" : "/files", "PUT", { id, name });
  }
  async upload(folderId: number, name: string, contents: Blob): Promise<void> {
    this.requireSession();
    const data = new FormData();
    data.append("file", contents, name);
    await this.request(`/folders/${folderId}/upload`, "/folders/{id}/upload", "POST", data);
  }
  async remove(id: number, folder: boolean): Promise<void> {
    this.requireSession();
    await this.request(folder ? `/folders/${id}` : `/files/${id}`, folder ? "/folders/{id}" : "/files/{id}", "DELETE", {});
  }
  async close(): Promise<void> {
    this.authenticated = false;
    this.identity = undefined;
    await this.jar.removeAllCookies();
  }
}
