import { ShufflrrClient, ShufflrrError } from "@workspace/shufflrr";
import { probeAccess } from "@workspace/shufflrr/probe";

// Explicit operator command; never invoked by server startup or ordinary browsing.
const client = new ShufflrrClient({ baseUrl: process.env.SHUFFLRR_API_BASE_URL ?? "", timeoutMs: 60_000 });
try {
  if (process.argv[2] !== "--confirm-temporary-changes") {
    throw new ShufflrrError("configuration", "Pass --confirm-temporary-changes to create, rename, and delete isolated test items in each accessible root.");
  }
  const email = process.env.SHUFFLRR_API_EMAIL;
  const password = process.env.SHUFFLRR_API_PASSWORD;
  if (!email || !password) throw new ShufflrrError("configuration", "Missing Shufflrr service-account credentials.");
  await client.login(email, password);
  const roots = await client.roots();
  const reports = [];
  // Probe root scopes, never modify existing folders or files.
  for (const root of roots) {
    const report = await probeAccess(client, root.id);
    reports.push({ reportedPermissions: root.userPermissions, ...report });
    if (!report.cleanupOk) break;
  }
  process.stdout.write(JSON.stringify({ checkedAt: new Date().toISOString(), rootCount: roots.length, reports }, null, 2) + "\n");
  process.exitCode = reports.length === roots.length && reports.every(report => report.ok) ? 0 : 2;
} catch (error) {
  process.stderr.write(JSON.stringify({
    event: "probe_failed",
    message: error instanceof ShufflrrError ? error.message : "The access probe failed.",
  }) + "\n");
  process.exitCode = 1;
} finally { await client.close(); }
