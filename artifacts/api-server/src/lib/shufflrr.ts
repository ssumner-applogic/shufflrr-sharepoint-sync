import { ShufflrrClient, ShufflrrError, type Entry } from "@workspace/shufflrr";
import { AppSessionConnections, AppConnectionError } from "@workspace/shufflrr/sessions";
import { clerkClient } from "@clerk/express";
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

type AppSession = { sessionId: string; userId: string };
const connections = new AppSessionConnections<ShufflrrClient>();
const cleanupTimer = setInterval(() => {
  void connections.sweep().catch(() => {
    logger.warn({ event: "shufflrr_session_cleanup_failed" }, "Expired connection cleanup failed.");
  });
}, 60_000);
cleanupTimer.unref();

export async function shufflrrSession(auth: AppSession): Promise<ShufflrrClient> {
  return connections.get(auth.sessionId, async () => {
    let appSession: Awaited<ReturnType<typeof clerkClient.sessions.getSession>>;
    try { appSession = await clerkClient.sessions.getSession(auth.sessionId); }
    catch {
      throw new ShufflrrError("network", "Could not verify the app session. Please retry.");
    }
    if (appSession.status !== "active" || appSession.userId !== auth.userId)
      throw new AppConnectionError("ended");
    // These are Clerk session deadlines in milliseconds, NOT the short-lived JWT exp.
    const expiresAt = Math.min(appSession.expireAt, appSession.abandonAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new AppConnectionError("ended");
    const client = newShufflrrClient();
    const config = shufflrrConfig();
    try { await client.login(config.email, config.password); }
    catch (error) { await client.close(); throw error; }
    return { client, expiresAt };
  });
}
export const endShufflrrSession = (sessionId: string) => connections.end(sessionId);
export async function closeShufflrrSessions(): Promise<void> {
  clearInterval(cleanupTimer);
  await connections.clear();
}
export async function readShufflrr<T>(auth: AppSession, operation: (client: ShufflrrClient) => Promise<T>): Promise<T> {
  const client = await shufflrrSession(auth);
  try { return await operation(client); }
  catch (error) {
    if (!(error instanceof ShufflrrError) || error.code !== "authentication") throw error;
    await connections.end(auth.sessionId, client);
    // A single fresh session retry is safe for read-only operations.
    return operation(await shufflrrSession(auth));
  }
}
export function shufflrrItem(entry: Entry) {
  return {
    id: entry.id, name: entry.name, isFolder: entry.isFolder,
    ...(entry.isArchived === undefined ? {} : { isArchived: entry.isArchived }),
    size: entry.size ?? 0, modifiedAt: entry.modifiedAt ?? "",
    permissions: entry.userPermissions === undefined ? "Not reported" : String(entry.userPermissions),
  };
}
