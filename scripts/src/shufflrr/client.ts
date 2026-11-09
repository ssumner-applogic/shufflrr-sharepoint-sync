import { randomUUID } from "node:crypto";
import { CookieJar } from "tough-cookie";

export class ShufflrrError extends Error {
  constructor(
    public readonly code: "configuration" | "authentication" | "permission" | "http" | "network" | "schema" | "limit",
    message: string,
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
  try {
    url = new URL(value);
  } catch {
    throw new ShufflrrError("configuration", "SHUFFLRR_API_BASE_URL must be an HTTPS Shufflrr portal URL ending in /api.");
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.shufflrr\.com$/i.test(url.hostname) ||
    url.username || url.password || url.port || url.search || url.hash ||
    !/^\/api\/?$/.test(url.pathname)
  ) {
    throw new ShufflrrError("configuration", "SHUFFLRR_API_BASE_URL must use your portal's HTTPS shufflrr.com host and /api path, without credentials, query parameters, or a custom port.");
  }
  return url.origin + "/api";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEntries(value: unknown, foldersOnly = false): Entry[] {
  if (!Array.isArray(value)) {
    throw new ShufflrrError("schema", "Unexpected API response: expected an array of folder/file records.");
  }
  if (value.length > 100_000) {
    throw new ShufflrrError("limit", "API response exceeded the 100,000-record safety limit.");
  }
  const keys = new Set<string>();
  return value.map((item: unknown): Entry => {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id < 0 ||
      typeof item.name !== "string" || item.name.length === 0 ||
      typeof item.isFolder !== "boolean" || (foldersOnly && !item.isFolder) ||
      (item.userPermissions !== undefined && item.userPermissions !== null &&
        typeof item.userPermissions !== "string" &&
        !(typeof item.userPermissions === "number" && Number.isSafeInteger(item.userPermissions)))
    ) {
      throw new ShufflrrError("schema", "Unexpected API response: invalid folder/file record. Check the portal's API schema.");
    }
    const key = `${item.isFolder}:${item.id}`;
    if (keys.has(key)) throw new ShufflrrError("schema", "API returned duplicate folder/file records.");
    keys.add(key);
    return {
      id: item.id,
      name: item.name,
      isFolder: item.isFolder,
      ...(item.userPermissions == null ? {} : { userPermissions: item.userPermissions as string | number }),
    };
  });
}

// Cookies are intentionally never serialized or written to disk.
export class ShufflrrClient {
  private readonly jar = new CookieJar();
  private readonly baseUrl: string;
  private readonly transport: typeof fetch;
  private authenticated = false;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    this.transport = options.transport ?? fetch;
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000) {
      throw new ShufflrrError("configuration", "Request timeout must be between 1 and 120000 milliseconds.");
    }
  }

  private async request(path: string, route: string, body?: unknown): Promise<unknown> {
    const url = this.baseUrl + path;
    const method = body === undefined ? "GET" : "POST";
    for (let attempt = 0; attempt < 3; attempt++) {
      const requestId = randomUUID();
      const started = performance.now();
      let status: number | undefined;
      try {
        const cookie = await this.jar.getCookieString(url);
        const response = await this.transport(url, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(this.options.timeoutMs),
          headers: {
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "X-Request-ID": requestId,
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        status = response.status;
        for (const header of response.headers.getSetCookie()) {
          await this.jar.setCookie(header, url);
        }
        if (method === "GET" && [429, 502, 503, 504].includes(status) && attempt < 2) {
          await response.body?.cancel();
          // Bounded retries apply only to idempotent reads, never login.
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 3000) : 250 * 2 ** attempt;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (status === 401) throw new ShufflrrError("authentication", "Authentication was rejected or the session expired.");
          if (status === 403) throw new ShufflrrError("permission", "Access denied. Check the service account's group and folder permissions.");
          if (status >= 300 && status < 400) {
            throw new ShufflrrError("http", "API redirected the request. Redirects are blocked to protect credentials; verify the portal URL and authentication settings.");
          }
          throw new ShufflrrError("http", `API request failed (HTTP ${status}).`);
        }
        if (!/application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) {
          await response.body?.cancel();
          throw new ShufflrrError("schema", "API did not return JSON. Check the portal's API URL and authentication settings.");
        }
        // Bound both downloaded bytes and the request/body-read time.
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
        } finally {
          reader.releaseLock();
        }
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
          throw new ShufflrrError("schema", "API returned invalid JSON.");
        }
      } catch (error) {
        if (error instanceof ShufflrrError) throw error;
        throw new ShufflrrError("network", "Request failed or timed out. Check connectivity, TLS, and the configured portal URL.");
      } finally {
        this.options.onRequest?.({
          requestId, method, route, status,
          durationMs: Math.round(performance.now() - started),
        });
      }
    }
    throw new ShufflrrError("http", "API retry limit reached.");
  }

  async login(emailAddress: string, password: string): Promise<void> {
    await this.close();
    const result = await this.request("/account/login", "/account/login", {
      emailAddress, password, keepLoggedIn: true,
    });
    if (!isRecord(result) || typeof result.success !== "boolean") {
      throw new ShufflrrError("schema", "Login returned an unexpected response; expected a success flag.");
    }
    if (!result.success) {
      throw new ShufflrrError("authentication", "Login failed. Check the service account credentials and portal access.");
    }
    if (!(await this.jar.getCookieString(this.baseUrl + "/folders"))) {
      throw new ShufflrrError("authentication", "Login succeeded but no usable session cookie was returned.");
    }
    this.authenticated = true;
  }

  async roots(): Promise<Entry[]> {
    if (!this.authenticated) throw new ShufflrrError("authentication", "Sign in before requesting folders.");
    return parseEntries(await this.request("/folders", "/folders"), true);
  }

  async contents(id: number): Promise<Entry[]> {
    if (!this.authenticated) throw new ShufflrrError("authentication", "Sign in before requesting folder contents.");
    if (!Number.isSafeInteger(id) || id < 0) throw new ShufflrrError("schema", "Invalid folder ID.");
    // Current official Swagger requires includeDelete in the path.
    return parseEntries(await this.request(`/folders/${id}/contents/false`, "/folders/{id}/contents/{includeDelete}"));
  }

  async close(): Promise<void> {
    this.authenticated = false;
    await this.jar.removeAllCookies();
  }
}
