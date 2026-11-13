import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { db, pool } from "@workspace/db";
import { fileMetadataTable, metadataRunsTable } from "@workspace/db/schema";
import { metadataFields } from "@workspace/shufflrr";
import { metadataRoutes } from "../routes/metadata";
import { logger } from "./logger";
import { METADATA_LOCK_ID, runMetadataCycle } from "./metadata-worker";
import { closeShufflrrSessions } from "./shufflrr";

test("metadata lookup and run responses work with existing captured files; concurrent claims skip safely", async t => {
  // Route-only harness: loopback, ephemeral port, no authentication changes in the app.
  // Only GETs are issued. Real-app sign-in and origin guards are smoke-tested separately.
  const app = express();
  app.use((req, _res, next) => { req.log = logger; req.id = randomUUID(); next(); });
  app.use(metadataRoutes());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const [snapshot] = await db.select().from(fileMetadataTable).orderBy(fileMetadataTable.id).limit(1);
    assert.ok(snapshot, "Run metadata:check against the first ten existing mappings before this smoke check.");
    await t.test("status and cursor-paged events serialize successfully", async () => {
      const response = await fetch(base + "/status");
      assert.equal(response.status, 200);
      const status = await response.json() as { runs: { id: string }[] };
      assert.ok(status.runs.length > 0);
      const events = await fetch(base + "/events?" + new URLSearchParams({ runId: status.runs[0]!.id, limit: "2" }));
      assert.equal(events.status, 200);
      const page = await events.json() as { events: { id: number }[]; nextAfter: number | null };
      assert.ok(page.events.length <= 2);
      if (page.nextAfter !== null) {
        const next = await fetch(base + "/events?" + new URLSearchParams({
          runId: status.runs[0]!.id, limit: "2", after: String(page.nextAfter),
        }));
        assert.equal(next.status, 200);
        const nextPage = await next.json() as { events: { id: number }[] };
        assert.ok(nextPage.events.every(event => event.id > page.nextAfter!));
      }
    });
    await t.test("SharePoint identity returns only the requested source fields", async () => {
      const response = await fetch(base + "/file?" + new URLSearchParams({ driveId: snapshot.driveId, itemId: snapshot.itemId }));
      assert.equal(response.status, 200);
      const body = await response.json() as { fields: Record<string, unknown>; mapped: boolean; observedAt: string };
      assert.ok(body.mapped);
      assert.ok(body.observedAt);
      assert.ok(Object.keys(body.fields).every(key => (metadataFields as readonly string[]).includes(key)));
      assert.equal(body.fields.id, snapshot.sourceFileId);
    });
    await t.test("invalid requests and out-of-scope lookups do not expose records", async () => {
      assert.equal((await fetch(base + "/events?runId=invalid")).status, 400);
      assert.equal((await fetch(base + "/events?runId=" + randomUUID())).status, 404);
      assert.equal((await fetch(base + "/file?" + new URLSearchParams({ driveId: "outside-scope", itemId: snapshot.itemId }))).status, 404);
    });
    await t.test("a second metadata worker cannot create a run while the claim is held", async () => {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        // A real worker may already be finishing a crawl. Wait boundedly, rather
        // than treating its legitimate ownership as a failed regression.
        await connection.query("SET LOCAL lock_timeout = '60s'");
        await connection.query("SELECT pg_advisory_xact_lock($1)", [METADATA_LOCK_ID]);
        const before = await db.select({ id: metadataRunsTable.id }).from(metadataRunsTable);
        assert.deepEqual(await runMetadataCycle({ force: true, limit: 10 }), { skipped: true });
        const after = await db.select({ id: metadataRunsTable.id }).from(metadataRunsTable);
        assert.equal(after.length, before.length);
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await closeShufflrrSessions();
    await pool.end();
  }
});
