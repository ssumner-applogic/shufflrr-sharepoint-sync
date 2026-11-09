import { ShufflrrClient, ShufflrrError, type Entry } from "@workspace/shufflrr";
import { logger } from "./logger";

export function shufflrrConfig() {
  const keys = ["SHUFFLRR_API_BASE_URL", "SHUFFLRR_API_EMAIL", "SHUFFLRR_API_PASSWORD"] as const;
  const missing = keys.filter(key => !process.env[key]?.trim());
  if (missing.length) {
    logger.warn({ event: "shufflrr_configuration_missing", missing }, "Shufflrr configuration is incomplete.");
    throw new ShufflrrError("configuration", "Shufflrr is not configured on this server. Contact the app administrator.");
  }
  return {
    baseUrl: process.env.SHUFFLRR_API_BASE_URL!,
    email: process.env.SHUFFLRR_API_EMAIL!,
    password: process.env.SHUFFLRR_API_PASSWORD!,
  };
}
export function newShufflrrClient(): ShufflrrClient {
  const config = shufflrrConfig();
  return new ShufflrrClient({
    baseUrl: config.baseUrl, timeoutMs: 60_000,
    onRequest: event => {
      const level = event.status && event.status < 400 ? "info" : "warn";
      logger[level]({ ...event, event: "shufflrr_request" }, "Shufflrr request finished.");
    },
  });
}

// One bounded, disposable service-account session, never a cache of user data.
let session: { client: ShufflrrClient; expiresAt: number } | undefined;
let login: Promise<ShufflrrClient> | undefined;
export async function shufflrrSession(): Promise<ShufflrrClient> {
  if (session && session.expiresAt > Date.now()) return session.client;
  if (login) return login;
  login = (async () => {
    const client = newShufflrrClient();
    const config = shufflrrConfig();
    await client.login(config.email, config.password);
    session = { client, expiresAt: Date.now() + 5 * 60_000 };
    return client;
  })();
  try { return await login; } finally { login = undefined; }
}
export async function readShufflrr<T>(operation: (client: ShufflrrClient) => Promise<T>): Promise<T> {
  const client = await shufflrrSession();
  try { return await operation(client); }
  catch (error) {
    if (!(error instanceof ShufflrrError) || error.code !== "authentication") throw error;
    if (session?.client === client) session = undefined;
    // A single fresh session retry is safe for read-only operations.
    return operation(await shufflrrSession());
  }
}
export function shufflrrItem(entry: Entry) {
  return {
    id: entry.id, name: entry.name, isFolder: entry.isFolder,
    size: entry.size ?? 0, modifiedAt: entry.modifiedAt ?? "",
    permissions: entry.userPermissions === undefined ? "Not reported" : String(entry.userPermissions),
  };
}
