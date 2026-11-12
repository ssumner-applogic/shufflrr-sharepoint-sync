import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { pool, syncConfigTable } from "@workspace/db";
import { nextSyncAfterCompletion, preserveSyncControlTimestamp } from "./sync-scheduling";

test("real PostgreSQL scheduling and pooled locking, with no persistent application writes", async t => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE sync_clock_probe (LIKE sync_config INCLUDING DEFAULTS) ON COMMIT DROP");
    const captured = new Date("2026-01-01T00:00:00.000Z");
    await client.query("INSERT INTO sync_clock_probe(id,enabled,updated_at) VALUES(1,true,$1)", [captured]);
    const mock = drizzle.mock();
    const executeUpdate = async (values: Parameters<ReturnType<typeof mock.update>["set"]>[0]) => {
      const query = mock.update(syncConfigTable).set(values).where(eq(syncConfigTable.id, 1)).toSQL();
      await client.query(query.sql.replaceAll('"sync_config"', '"sync_clock_probe"'), query.params);
    };
    const running = () => executeUpdate({ lastRunStatus: "running", updatedAt: preserveSyncControlTimestamp() });
    const finish = (cooldown?: Date) => executeUpdate({
      lastRunStatus: "partial", updatedAt: preserveSyncControlTimestamp(),
      nextRunAt: nextSyncAfterCompletion(captured, cooldown),
    });
    for (const interval of [1, 5, 30, 60, 300, 3600]) {
      await t.test(`completion waits ${interval} seconds despite its own running-status update`, async () => {
        await client.query("UPDATE sync_clock_probe SET enabled=true,updated_at=$1,poll_interval_seconds=$2,next_run_at=now()-interval '1 second'", [captured, interval]);
        await running(); await finish();
        const { rows: [row] } = await client.query("SELECT updated_at,extract(epoch FROM next_run_at-now())::integer AS delay FROM sync_clock_probe");
        assert.equal(row.updated_at.getTime(), captured.getTime());
        assert.equal(row.delay, interval);
      });
    }
    await t.test("a genuine newer Start or Sync now request is preserved", async () => {
      await client.query("UPDATE sync_clock_probe SET enabled=true,updated_at=$1,next_run_at=now()", [new Date(captured.getTime() + 1000)]);
      await finish();
      const { rows: [row] } = await client.query("SELECT extract(epoch FROM next_run_at-now())::integer AS delay FROM sync_clock_probe");
      assert.equal(row.delay, 0);
    });
    await t.test("pausing during a run stays paused and does not schedule an immediate restart", async () => {
      await client.query("UPDATE sync_clock_probe SET enabled=false,updated_at=$1,next_run_at=now(),poll_interval_seconds=300", [new Date(captured.getTime() + 2000)]);
      await finish();
      const { rows: [row] } = await client.query("SELECT enabled,extract(epoch FROM next_run_at-now())::integer AS delay FROM sync_clock_probe");
      assert.equal(row.enabled, false); assert.equal(row.delay, 300);
    });
    await t.test("provider cooldown cannot be bypassed by a newer manual request", async () => {
      const { rows: [clock] } = await client.query("SELECT now()+interval '600 seconds' AS cooldown");
      await client.query("UPDATE sync_clock_probe SET enabled=true,updated_at=$1,next_run_at=now()", [new Date(captured.getTime() + 3000)]);
      await finish(clock.cooldown);
      const { rows: [row] } = await client.query("SELECT extract(epoch FROM next_run_at-now())::integer AS delay FROM sync_clock_probe");
      assert.equal(row.delay, 600);
    });
    await t.test("two pooled transactions cannot hold the same isolated test lock", async () => {
      const other = await pool.connect();
      const keys = [randomInt(1, 2147483647), randomInt(1, 2147483647)];
      try {
        await other.query("BEGIN");
        // The two-key namespace cannot overlap the application's one-key run lock.
        assert.equal((await client.query("SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS locked", keys)).rows[0].locked, true);
        assert.equal((await other.query("SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS locked", keys)).rows[0].locked, false);
        await client.query("ROLLBACK");
        assert.equal((await other.query("SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS locked", keys)).rows[0].locked, true);
      } finally {
        await other.query("ROLLBACK").catch(() => {});
        other.release();
      }
    });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
});
