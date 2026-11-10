import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to apply the explicit database migration.");
}

const pool = new Pool({ connectionString, max: 1 });
const migrationPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations/0001_sync_agent.sql");
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(74120937)");
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const migrationId = "0001_sync_agent";
  const applied = await client.query("SELECT 1 FROM app_schema_migrations WHERE id = $1", [migrationId]);
  if (applied.rowCount === 0) {
    await client.query(await readFile(migrationPath, "utf8"));
    await client.query("INSERT INTO app_schema_migrations (id) VALUES ($1)", [migrationId]);
  }
  await client.query("COMMIT");
  process.stdout.write("Sync Agent database migration is applied.\n");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
