import test from "node:test";
import assert from "node:assert/strict";
import { AppConnectionError, AppSessionConnections } from "@workspace/shufflrr/sessions";

class FakeConnection {
  closed = 0;
  async close() { this.closed++; }
}
const hours = (n: number) => n * 60 * 60_000;

test("keeps a connection beyond five minutes, until the app session actually expires", async () => {
  let now = 1000;
  let logins = 0;
  const pool = new AppSessionConnections<FakeConnection>(4, () => now);
  const create = async () => ({ client: new FakeConnection(), expiresAt: (logins++, hours(12)) });
  const first = await pool.get("app-session", create);
  now += hours(6);
  assert.equal(await pool.get("app-session", create), first);
  assert.equal(logins, 1);
  assert.equal(first.closed, 0);
  now = hours(12);
  await pool.sweep();
  assert.equal(first.closed, 1);
});

test("connections are scoped to app sessions; signing out one does not affect another", async () => {
  const pool = new AppSessionConnections<FakeConnection>();
  const create = async () => ({ client: new FakeConnection(), expiresAt: Date.now() + hours(1) });
  const first = await pool.get("session-a", create);
  const second = await pool.get("session-b", create);
  assert.notEqual(first, second);
  await pool.end("session-a");
  await pool.end("session-a"); // Idempotent logout.
  assert.equal(first.closed, 1);
  assert.equal(second.closed, 0);
  assert.equal(await pool.get("session-b", create), second);
  assert.notEqual(await pool.get("session-a", create), first);
  await pool.clear();
});

test("concurrent requests share one login", async () => {
  const pool = new AppSessionConnections<FakeConnection>();
  let logins = 0;
  const create = async () => {
    logins++;
    await Promise.resolve();
    return { client: new FakeConnection(), expiresAt: Date.now() + hours(1) };
  };
  const clients = await Promise.all(Array.from({ length: 10 }, () => pool.get("session", create)));
  assert.equal(logins, 1);
  assert.ok(clients.every(client => client === clients[0]));
  await pool.clear();
});

test("failed logins are not retained and can be retried", async () => {
  const pool = new AppSessionConnections<FakeConnection>();
  await assert.rejects(pool.get("session", async () => { throw Error("failed"); }));
  const client = await pool.get("session", async () => ({ client: new FakeConnection(), expiresAt: Date.now() + hours(1) }));
  assert.equal(client.closed, 0);
  await pool.clear();
});

test("a login completing after logout discards its cookies instead of resurrecting the connection", async () => {
  const pool = new AppSessionConnections<FakeConnection>();
  const client = new FakeConnection();
  let finish!: (value: { client: FakeConnection; expiresAt: number }) => void;
  const pending = pool.get("session", () => new Promise(resolve => { finish = resolve; }));
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof AppConnectionError && error.code === "ended");
  // Let get() finish the initial sweep and register the pending login.
  while (!finish) await Promise.resolve();
  await pool.end("session");
  finish({ client, expiresAt: Date.now() + hours(1) });
  await rejected;
  assert.equal(client.closed, 1);
  const replacement = await pool.get("session", async () => ({ client: new FakeConnection(), expiresAt: Date.now() + hours(1) }));
  assert.notEqual(replacement, client);
  await pool.clear();
});

test("a stale request cannot invalidate a refreshed connection", async () => {
  const pool = new AppSessionConnections<FakeConnection>();
  const create = async () => ({ client: new FakeConnection(), expiresAt: Date.now() + hours(1) });
  const old = await pool.get("session", create);
  await pool.end("session", old);
  const current = await pool.get("session", create);
  await pool.end("session", old);
  assert.equal(current.closed, 0);
  assert.equal(await pool.get("session", create), current);
  await pool.clear();
});

test("bounds memory without evicting live connections and releases capacity after logout", async () => {
  const pool = new AppSessionConnections<FakeConnection>(1);
  const create = async () => ({ client: new FakeConnection(), expiresAt: Date.now() + hours(1) });
  const first = await pool.get("a", create);
  await assert.rejects(pool.get("b", create), (error: unknown) => error instanceof AppConnectionError && error.code === "capacity");
  assert.equal(first.closed, 0);
  await pool.end("a");
  await pool.get("b", create);
  await pool.clear();
});

test("refuses expired or invalid app session deadlines and closes new clients", async () => {
  const pool = new AppSessionConnections<FakeConnection>(2, () => 100);
  for (const expiresAt of [99, 100, NaN, Infinity]) {
    const client = new FakeConnection();
    await assert.rejects(pool.get("session", async () => ({ client, expiresAt })), AppConnectionError);
    assert.equal(client.closed, 1);
  }
});
