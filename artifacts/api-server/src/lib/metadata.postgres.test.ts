import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { db, pool } from "@workspace/db";
import { fileMetadataTable, metadataRunsTable, metadataControlTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { nextMetadataCrawlAt, saveMetadataInterval } from "./metadata-store";
import { metadataFields } from "@workspace/shufflrr";
import { metadataRoutes } from "../routes/metadata";
import { logger } from "./logger";
import { METADATA_LOCK_ID, runMetadataCycle } from "./metadata-worker";
import { closeShufflrrSessions } from "./shufflrr";

test("metadata lookup and run responses work with existing captured files; concurrent claims skip safely", async t => {
  // Route-only harness: loopback, ephemeral port, no authentication changes in the app.
  // Provider data is read-only. Schedule writes below are rolled back.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = logger; req.id = randomUUID(); next(); });
  app.use(metadataRoutes());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await t.test("shared schedule persists all four choices and completion honors the latest choice", async () => {
      const rollback = new Error("Roll back schedule verification");
      await assert.rejects(db.transaction(async tx => {
        const [before] = await tx.select().from(metadataControlTable).where(eq(metadataControlTable.id, 1));
        const futureCooldown = new Date(Date.now() + 120_000);
        await tx.update(metadataControlTable).set({ retryAt: futureCooldown }).where(eq(metadataControlTable.id, 1));
        for (const interval of [300, 600, 900, 3600]) {
          const now = Date.now();
          const saved = await saveMetadataInterval(tx, interval);
          const [read] = await tx.select().from(metadataControlTable).where(eq(metadataControlTable.id, 1));
          assert.equal(read!.intervalSeconds, interval);
          assert.equal(saved.intervalSeconds, interval);
          assert.ok(saved.nextCrawlAt.getTime() >= now + interval * 1000 - 1000);
          assert.ok(saved.nextCrawlAt.getTime() <= Date.now() + interval * 1000 + 1000);
          assert.equal(read!.retryAt?.getTime(), futureCooldown.getTime(), "Must not bypass provider cooldown");
          assert.equal(read!.requestedAt?.getTime(), before!.requestedAt?.getTime(), "Must not enqueue a manual refresh");
        }
        // Simulate a worker that began before a user changed the interval.
        await saveMetadataInterval(tx, 900);
        const [completed] = await tx.update(metadataControlTable).set({ nextCrawlAt: nextMetadataCrawlAt() })
          .where(eq(metadataControlTable.id, 1)).returning();
        assert.equal(completed!.intervalSeconds, 900);
        assert.ok(Math.abs(completed!.nextCrawlAt.getTime() - Date.now() - 900_000) < 2000);
        throw rollback;
      }), error => error === rollback);
    });
    await t.test("the interval endpoint rejects unsupported values without changing configuration", async () => {
      for (const body of [{}, { intervalSeconds: 60 }, { intervalSeconds: "300" }, { intervalSeconds: -1 }]) {
        const response = await fetch(base + "/interval", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
      }
    });
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
    await t.test("both browser identities retrieve the same captured metadata for ten existing files", async () => {
      const snapshots = await db.select().from(fileMetadataTable).orderBy(fileMetadataTable.id).limit(10);
      assert.equal(snapshots.length, 10);
      for (const saved of snapshots) {
        const source = await fetch(base + "/lookup?" + new URLSearchParams({ sourceFileId: String(saved.sourceFileId) }));
        const target = await fetch(base + "/lookup?" + new URLSearchParams({ itemId: saved.itemId }));
        assert.equal(source.status, 200);
        assert.equal(target.status, 200);
        const sourceRecord = await source.json() as { sourceFileId: number; fields: Record<string, unknown> };
        const targetRecord = await target.json() as { sourceFileId: number; fields: Record<string, unknown> };
        assert.equal(sourceRecord.sourceFileId, saved.sourceFileId);
        assert.deepEqual(sourceRecord.fields, targetRecord.fields);
        assert.ok(Object.keys(sourceRecord.fields).every(key => (metadataFields as readonly string[]).includes(key)));
      }
    });
    await t.test("invalid requests and out-of-scope lookups do not expose records", async () => {
      assert.equal((await fetch(base + "/events?runId=invalid")).status, 400);
      assert.equal((await fetch(base + "/events?runId=" + randomUUID())).status, 404);
      assert.equal((await fetch(base + "/file?" + new URLSearchParams({ driveId: "outside-scope", itemId: snapshot.itemId }))).status, 404);
      for (const query of ["", "?sourceFileId=0", "?sourceFileId=invalid",
        "?sourceFileId=1&itemId=ambiguous", "?itemId="]) {
        assert.equal((await fetch(base + "/lookup" + query)).status, 400);
      }
      assert.equal((await fetch(base + "/lookup?itemId=not-a-mapped-file")).status, 404);
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
