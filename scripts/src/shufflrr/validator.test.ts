import assert from "node:assert/strict";
import { test } from "node:test";
import { ShufflrrClient, ShufflrrError, parseEntries, validateBaseUrl, type Entry } from "./client";
import { scanFolders, renderTree, terminalText } from "./explorer";
import { runValidator } from "./validate";

const baseUrl = "https://test-portal.shufflrr.com/api";
const env: NodeJS.ProcessEnv = {
  SHUFFLRR_API_BASE_URL: baseUrl,
  SHUFFLRR_API_EMAIL: "service@example.invalid",
  SHUFFLRR_API_PASSWORD: "test-only-password",
};
const limits = { maxDepth: 100, maxFolders: 5000, maxItems: 100_000 };
const folder = (id: number, name = `Folder ${id}`): Entry =>
  ({ id, name, isFolder: true, userPermissions: "Read" });
const file = (id: number, name = "Deck.pptx"): Entry => ({ id, name, isFolder: false });
const json = (body: unknown, status = 200, cookie?: string) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...(cookie ? { "Set-Cookie": cookie } : {}) },
});
const login = () => json({ success: true }, 200, "session=test-only-session; Path=/api; Secure; HttpOnly");
const transport = (handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  async (input, init) => handler(new URL(String(input)), init ?? {});

test("requires a precise HTTPS Shufflrr portal base URL", () => {
  assert.equal(validateBaseUrl(baseUrl + "/"), baseUrl);
  for (const value of [
    "http://test-portal.shufflrr.com/api", "https://shufflrr.com/api",
    "https://test-portal.shufflrr.com.attacker.invalid/api", "https://localhost/api",
    "https://user:password@test-portal.shufflrr.com/api", baseUrl + "/api",
    baseUrl + "?token=private", baseUrl + "#private", "not a URL",
  ]) {
    assert.throws(() => validateBaseUrl(value), ShufflrrError);
  }
});

test("validates the folder/file schema rather than silently treating errors as empty lists", () => {
  assert.deepEqual(parseEntries([folder(1), file(2)]), [folder(1), file(2)]);
  for (const value of [{ items: [] }, [{ id: 1, name: "x" }], [folder(1), folder(1)]]) {
    assert.throws(() => parseEntries(value), ShufflrrError);
  }
  assert.throws(() => parseEntries([file(1)], true), ShufflrrError);
});

test("preserves verified Shufflrr archive metadata without inferring state from file names", () => {
  assert.equal(parseEntries([{ ...file(2), storageStatus: "MovedToGlacier" }])[0].isArchived, true);
  assert.equal(parseEntries([{ ...file(2), name: "Archived.png", storageStatus: "Normal" }])[0].isArchived, false);
  assert.equal(parseEntries([file(2)])[0].isArchived, undefined);
  assert.throws(() => parseEntries([{ ...file(2), storageStatus: true }]), ShufflrrError);
});

test("sends the documented login payload and reuses path-scoped cookies", async () => {
  const seen: string[] = [];
  const client = new ShufflrrClient({ baseUrl, timeoutMs: 1000, transport: transport((url, init) => {
    seen.push(url.pathname);
    assert.equal(init.redirect, "manual");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("X-Requested-With"), "XMLHttpRequest");
    if (url.pathname.endsWith("/login")) {
      assert.equal(headers.get("Cookie"), null);
      assert.equal(headers.get("Content-Type"), "application/json");
      assert.deepEqual(JSON.parse(String(init.body)), {
        emailAddress: env.SHUFFLRR_API_EMAIL, password: env.SHUFFLRR_API_PASSWORD, keepLoggedIn: true,
      });
      return login();
    }
    assert.equal(headers.get("Cookie"), "session=test-only-session");
    return json(url.pathname === "/api/folders" ? [folder(1)] : [file(2)]);
  }) });
  await client.login(env.SHUFFLRR_API_EMAIL!, env.SHUFFLRR_API_PASSWORD!);
  assert.equal((await client.roots()).length, 1);
  assert.equal((await client.contents(1))[0].isFolder, false);
  assert.deepEqual(seen, ["/api/account/login", "/api/folders", "/api/folders/1/contents/false"]);
  await client.close();
  await assert.rejects(client.roots(), /Sign in/);
});

test("failed login and missing or wrongly scoped session cookies fail explicitly", async () => {
  for (const response of [
    json({ success: false }),
    json({ success: true }),
    json({ success: true }, 200, "session=test; Path=/unrelated; Secure"),
    json({ error: "not logged in" }),
  ]) {
    const client = new ShufflrrClient({ baseUrl, timeoutMs: 1000, transport: transport(() => response) });
    await assert.rejects(client.login("service@example.invalid", "test-only-password"), ShufflrrError);
    await client.close();
  }
});

test("blocks redirects and never retries login or leaks provider error bodies", async () => {
  for (const response of [
    new Response("", { status: 302, headers: { Location: "https://other.invalid/" } }),
    new Response("private provider diagnostic", { status: 403 }),
    json({ message: "private provider diagnostic" }, 503),
  ]) {
    let calls = 0;
    const client = new ShufflrrClient({
      baseUrl, timeoutMs: 1000, transport: transport(() => { calls++; return response; }),
    });
    await assert.rejects(client.login("service@example.invalid", "test-only-password"), error => {
      assert.ok(error instanceof ShufflrrError);
      assert.doesNotMatch(error.message, /private provider diagnostic/);
      return true;
    });
    assert.equal(calls, 1);
    await client.close();
  }
});

test("bounds idempotent GET retries and recovers from a transient failure", async () => {
  let reads = 0;
  const client = new ShufflrrClient({ baseUrl, timeoutMs: 1000, transport: transport(url => {
    if (url.pathname.endsWith("/login")) return login();
    reads++;
    return reads < 2 ? json({}, 503) : json([]);
  }) });
  await client.login("service@example.invalid", "test-only-password");
  assert.deepEqual(await client.roots(), []);
  assert.equal(reads, 2);
  await client.close();
});

test("reports network errors safely, without arbitrary transport error content", async () => {
  const client = new ShufflrrClient({ baseUrl, timeoutMs: 1000, transport: transport(() => {
    throw new Error("SECRET_VALUE_IN_UPSTREAM_ERROR");
  }) });
  await assert.rejects(client.login("service@example.invalid", "test-only-password"), error => {
    assert.ok(error instanceof ShufflrrError);
    assert.equal(error.code, "network");
    assert.doesNotMatch(error.message, /SECRET_VALUE/);
    return true;
  });
  await client.close();
});

test("rejects non-JSON, malformed JSON, and oversized responses", async () => {
  for (const response of [
    new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }),
    new Response("{", { headers: { "Content-Type": "application/json" } }),
    new Response("x".repeat(10 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } }),
  ]) {
    const client = new ShufflrrClient({ baseUrl, timeoutMs: 1000, transport: transport(() => response) });
    await assert.rejects(client.login("service@example.invalid", "test-only-password"), ShufflrrError);
    await client.close();
  }
});

test("applies a real timeout signal to requests", async () => {
  const client = new ShufflrrClient({
    baseUrl, timeoutMs: 10,
    transport: transport(async (_url, init) => {
      assert.ok(init.signal);
      await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout signal was not fired")), 500);
        init.signal!.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        }, { once: true });
      });
      return login();
    }),
  });
  await assert.rejects(client.login("service@example.invalid", "test-only-password"), error => {
    assert.ok(error instanceof ShufflrrError);
    assert.equal(error.code, "network");
    return true;
  });
  await client.close();
});

test("operator permission grant targets only the authenticated service principal", async () => {
  const client = new ShufflrrClient({
    baseUrl, timeoutMs: 1000, transport: transport((url, init) => {
      if (url.pathname.endsWith("/login")) return json({
        success: true, user: { id: "00000000-0000-0000-0000-000000000001", portalId: 1 },
      }, 200, "session=test; Path=/api; Secure");
      assert.equal(url.pathname, "/api/folders/1/permissions");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), {
        principalIds: ["00000000-0000-0000-0000-000000000001"], permission: "FullControl",
      });
      return json({ ...folder(1), userPermissions: "Read, Write, FullControl" });
    }),
  });
  await client.login("service@example.invalid", "test-only-password");
  assert.match(String((await client.grantOwnFolderControl(1)).userPermissions), /FullControl/);
  await client.close();
});

test("maps nested and empty folders with stable folders-first tree output", async () => {
  const result = await scanFolders({
    roots: async () => [folder(1, "Library")],
    contents: async id => id === 1 ? [file(4), folder(2, "Empty"), folder(3, "Child")] :
      id === 3 ? [file(5, "Notes.pdf")] : [],
  }, limits);
  assert.deepEqual(
    { folders: result.folders, read: result.foldersRead, files: result.files, issues: result.issues },
    { folders: 3, read: 3, files: 2, issues: 0 },
  );
  assert.equal(renderTree(result), [
    "Shufflrr/", "└── Library/ [reported: Read]", "    ├── Child/ [reported: Read]",
    "    │   └── Notes.pdf", "    ├── Empty/ [reported: Read]", "    └── Deck.pptx",
  ].join("\n"));
  assert.match(renderTree(result, true), /`-- Library/);
});

test("marks forbidden subtrees but continues reading accessible siblings", async () => {
  const result = await scanFolders({
    roots: async () => [folder(1, "Denied"), folder(2, "Readable")],
    contents: async id => {
      if (id === 1) throw new ShufflrrError("permission", "Access denied.");
      return [file(3)];
    },
  }, limits);
  assert.equal(result.issues, 1);
  assert.equal(result.files, 1);
  assert.match(renderTree(result), /Denied.*Access denied/);
});

test("stops making requests after authentication expires", async () => {
  let calls = 0;
  const result = await scanFolders({
    roots: async () => [folder(1), folder(2)],
    contents: async () => { calls++; throw new ShufflrrError("authentication", "Session expired."); },
  }, limits);
  assert.equal(calls, 1);
  assert.equal(result.issues, 2);
});

test("detects cycles and enforces depth, folder-attempt, and total item limits", async () => {
  const cyclic = await scanFolders({
    roots: async () => [folder(1)],
    contents: async () => [folder(1)],
  }, limits);
  assert.equal(cyclic.issues, 1);
  assert.match(renderTree(cyclic), /cycle or duplicate/);
  const depth = await scanFolders({
    roots: async () => [folder(1)],
    contents: async () => [folder(2)],
  }, { ...limits, maxDepth: 0 });
  assert.match(renderTree(depth), /depth limit/);
  let calls = 0;
  const count = await scanFolders({
    roots: async () => [folder(1), folder(2)],
    contents: async () => { calls++; throw new ShufflrrError("permission", "Access denied."); },
  }, { ...limits, maxFolders: 1 });
  assert.equal(calls, 1);
  assert.match(renderTree(count), /folder limit/);
  const items = await scanFolders({
    roots: async () => [folder(1)], contents: async () => [file(2), file(3)],
  }, { ...limits, maxItems: 2 });
  assert.equal(items.issues, 1);
  assert.match(renderTree(items), /item limit/);
});

test("escapes terminal control characters and bidi overrides in names", () => {
  assert.equal(terminalText("Deck\u001b[31m\n\u202E.pptx"), "Deck\\u001b[31m\\u000a\\u202e.pptx");
});

test("CLI produces the tree, reports checks, and keeps credentials and IDs out of logs", async () => {
  let stdout = "", stderr = "";
  const exit = await runValidator([], env, {
    out: text => { stdout += text; }, err: text => { stderr += text; },
  }, transport(url => url.pathname.endsWith("/login") ? login() :
    json(url.pathname === "/api/folders" ? [folder(987654321, "Library")] : [file(2)])));
  assert.equal(exit, 0);
  assert.match(stdout, /Library\/.*reported: Read/);
  assert.match(stdout, /PASS:/);
  assert.match(stdout, /Write access was not tested/);
  for (const value of ["test-only-password", "test-only-session", "service@example.invalid", "987654321", "Library"]) {
    assert.ok(!stderr.includes(value));
  }
  for (const line of stderr.trim().split("\n")) {
    const log = JSON.parse(line);
    assert.equal(typeof log.timestamp, "string");
    assert.equal(typeof log.event, "string");
  }
});

test("CLI exit codes distinguish complete, partial, login-failed, and malformed responses", async () => {
  for (const [mode, expected] of [["partial", 2], ["failed", 1], ["schema", 1]] as const) {
    let stdout = "";
    const exit = await runValidator([], env, { out: text => { stdout += text; }, err: () => {} },
      transport(url => {
        if (url.pathname.endsWith("/login")) return mode === "failed" ? json({ success: false }) : login();
        if (url.pathname === "/api/folders") return json(mode === "schema" ? { items: [] } : [folder(1)]);
        return json({}, 403);
      }));
    assert.equal(exit, expected);
    if (expected === 2) assert.match(stdout, /PARTIAL:/);
    else assert.doesNotMatch(stdout, /PASS:/);
  }
});

test("CLI help needs no credentials and rejects missing config and bad options", async () => {
  let stdout = "";
  const io = { out: (text: string) => { stdout += text; }, err: () => {} };
  assert.equal(await runValidator(["--help"], {}, io), 0);
  assert.match(stdout, /SHUFFLRR_API_PASSWORD/);
  assert.equal(await runValidator([], {}, io), 1);
  assert.equal(await runValidator(["--max-folders", "0"], env, io), 1);
  assert.equal(await runValidator(["--unknown"], env, io), 1);
});

test("empty portal is explicit about unverified folder-content access", async () => {
  let stdout = "";
  const exit = await runValidator([], env, {
    out: text => { stdout += text; }, err: () => {},
  }, transport(url => url.pathname.endsWith("/login") ? login() : json([])));
  assert.equal(exit, 0);
  assert.match(stdout, /Folder-content permissions could not be verified/);
});
