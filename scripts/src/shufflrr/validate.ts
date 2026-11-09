import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ShufflrrClient, ShufflrrError, validateBaseUrl } from "./client";
import { renderTree, scanFolders } from "./explorer";

const help = `Shufflrr API Validator & Folder Content Explorer

Usage: pnpm shufflrr:validate [options]

Required environment variables (never pass credentials on the command line):
  SHUFFLRR_API_BASE_URL  HTTPS portal API URL ending in /api
  SHUFFLRR_API_EMAIL     Dedicated service account email
  SHUFFLRR_API_PASSWORD  Dedicated service account password

Options:
  --ascii                 Use ASCII directory-tree connectors
  --timeout-ms <number>   Per-request timeout, including body read (default 20000)
  --max-folders <number>  Maximum folders to read (default 5000)
  --max-depth <number>    Maximum depth below root folders (default 100)
  --max-items <number>    Maximum total discovered entries (default 100000)
  --help                  Show this help

Read-only: verifies login, root listing, and folder-content access.
Reported permissions are not proof of write/upload/delete access.
Only content visible to the service account can be mapped.
Exit codes: 0 = complete visible tree, 1 = startup/login/root-list failure,
            2 = partial tree (unreadable folder, cycle, or safety limit).
Tree goes to stdout; safe structured diagnostics go to stderr.
`;

interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

function integerOption(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
    Number(value) < min || Number(value) > max) {
    throw new ShufflrrError("configuration", `Numeric options must be integers in the documented range (${min}–${max}).`);
  }
  return Number(value);
}

export async function runValidator(
  args: string[],
  env: NodeJS.ProcessEnv,
  output: Output,
  transport: typeof fetch = fetch,
): Promise<number> {
  let client: ShufflrrClient | undefined;
  const log = (level: "info" | "warn" | "error", event: string, message: string, fields: Record<string, unknown> = {}) => {
    if (env.LOG_LEVEL === "error" && level !== "error") return;
    if (env.LOG_LEVEL === "warn" && level === "info") return;
    output.err(JSON.stringify({
      timestamp: new Date().toISOString(), level, environment: env.NODE_ENV || "development",
      service: "shufflrr-validator", event, message, ...fields,
    }) + "\n");
  };
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args, allowPositionals: false, strict: true,
        options: {
          ascii: { type: "boolean" }, help: { type: "boolean" },
          "timeout-ms": { type: "string" }, "max-folders": { type: "string" },
          "max-depth": { type: "string" }, "max-items": { type: "string" },
        },
      });
    } catch {
      throw new ShufflrrError("configuration", "Invalid options. Run pnpm shufflrr:validate --help.");
    }
    if (parsed.values.help) {
      output.out(help);
      return 0;
    }
    const required = ["SHUFFLRR_API_BASE_URL", "SHUFFLRR_API_EMAIL", "SHUFFLRR_API_PASSWORD"] as const;
    const missing = required.filter(key => !env[key]?.trim());
    if (missing.length) throw new ShufflrrError("configuration", `Missing required configuration: ${missing.join(", ")}.`);
    const baseUrl = validateBaseUrl(env.SHUFFLRR_API_BASE_URL!);
    const email = env.SHUFFLRR_API_EMAIL!.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ShufflrrError("configuration", "SHUFFLRR_API_EMAIL must be a valid email address.");
    }
    const numberOption = (name: string, fallback: number, min: number, max: number) =>
      integerOption(parsed.values[name] as string | undefined, fallback, min, max);
    const scanOptions = {
      maxFolders: numberOption("max-folders", 5000, 1, 100_000),
      maxDepth: numberOption("max-depth", 100, 0, 1000),
      maxItems: numberOption("max-items", 100_000, 1, 1_000_000),
    };
    client = new ShufflrrClient({
      baseUrl, timeoutMs: numberOption("timeout-ms", 20_000, 1, 120_000), transport,
      onRequest: event => log(event.status && event.status < 400 ? "info" : "warn",
        "api_request", "Shufflrr API request finished.", { ...event }),
    });
    log("info", "validator_start", "Required configuration is present; starting read-only validation.");
    await client.login(email, env.SHUFFLRR_API_PASSWORD!);
    log("info", "authentication_passed", "Service account authenticated.");
    const result = await scanFolders(client, scanOptions);
    output.out(renderTree(result, parsed.values.ascii === true) + "\n\n");
    output.out(`${result.folders} folders discovered; ${result.foldersRead} read; ${result.files} files; ${result.issues} issues.\n`);
    output.out(result.issues
      ? "PARTIAL: not all discovered folders could be read.\n"
      : result.roots.length === 0
        ? "PASS: login and root listing succeeded; no accessible folders to check. Folder-content permissions could not be verified.\n"
        : "PASS: visible folder hierarchy read successfully.\n");
    output.out("Scope: service-account-visible folders only. Write access was not tested.\n");
    log(result.issues ? "warn" : "info", "validator_complete",
      result.issues ? "Folder mapping is incomplete." : "Visible folder mapping completed.",
      { folders: result.folders, foldersRead: result.foldersRead, files: result.files, issues: result.issues });
    return result.issues ? 2 : 0;
  } catch (error) {
    log("error", "validator_failed",
      error instanceof ShufflrrError ? error.message : "Unexpected validator failure.",
      { code: error instanceof ShufflrrError ? error.code : "unexpected" });
    return 1;
  } finally {
    await client?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runValidator(process.argv.slice(2), process.env, {
    out: text => { process.stdout.write(text); },
    err: text => { process.stderr.write(text); },
  });
}
