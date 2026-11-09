import { test } from "node:test";
import assert from "node:assert/strict";
import { probeAccess, probePdf, type ProbeClient } from "@workspace/shufflrr/probe";
import { ShufflrrError, type Entry } from "@workspace/shufflrr";

class FakeProbeClient implements ProbeClient {
  data = new Map<number, Entry[]>([[1, []]]);
  root: Entry = { id: 1, name: "Selected root", isFolder: true };
  calls: string[] = [];
  deny?: string;
  unexpected = false;
  sequence = 10;
  roots = async () => [this.root];
  contents = async (id: number) => [...(this.data.get(id) ?? [])];
  check(action: string) {
    this.calls.push(action);
    if (this.deny === action) throw new ShufflrrError("permission", "Access denied.");
  }
  async createFolder(parent: number, name: string) {
    this.check("create-folder");
    const item = { id: this.sequence++, name, isFolder: true };
    this.data.get(parent)!.push(item);
    this.data.set(item.id, []);
    return { ...item };
  }
  async rename(id: number, name: string, folder: boolean) {
    this.check(folder ? "rename-folder" : "rename-file");
    for (const entries of this.data.values()) {
      const item = entries.find(entry => entry.id === id);
      if (item) item.name = name;
    }
  }
  async upload(id: number, name: string) {
    this.check("upload-file");
    this.data.get(id)!.push({ id: this.sequence++, name, isFolder: false });
    if (this.unexpected) this.data.get(id)!.push({ id: 500, name: "Unrelated.pdf", isFolder: false });
  }
  async download(_id: number) {
    this.check("read-file");
    return new Response(probePdf());
  }
  async remove(id: number, folder: boolean) {
    this.check(folder ? "delete-folder" : "delete-file");
    for (const [parent, entries] of this.data) this.data.set(parent, entries.filter(entry => entry.id !== id));
    if (folder) this.data.delete(id);
  }
}
test("probe verifies every operation and leaves the original root untouched", async () => {
  const client = new FakeProbeClient();
  const existing = { id: 9, name: "Existing.pdf", isFolder: false };
  client.data.get(1)!.push(existing);
  const report = await probeAccess(client, 1, async () => {});
  assert.equal(report.ok, true);
  assert.equal(report.cleanupOk, true);
  assert.ok(report.steps.every(step => step.status === "passed"));
  assert.deepEqual(await client.contents(1), [existing]);
});
test("probe reports denied creation without claiming writes are granted", async () => {
  const client = new FakeProbeClient();
  client.deny = "create-folder";
  const report = await probeAccess(client, 1);
  assert.equal(report.ok, false);
  assert.equal(report.cleanupOk, true);
  assert.equal(report.steps[1].status, "failed");
  assert.ok(report.steps.slice(2).every(step => step.status === "skipped"));
  assert.deepEqual(await client.contents(1), []);
});
test("probe cleans up its own new items when a later operation fails", async () => {
  const client = new FakeProbeClient();
  client.deny = "rename-file";
  const report = await probeAccess(client, 1);
  assert.equal(report.ok, false);
  assert.equal(report.cleanupOk, true);
  assert.deepEqual(await client.contents(1), []);
});
test("probe explicitly reports cleanup failure if deletion is denied", async () => {
  const client = new FakeProbeClient();
  client.deny = "delete-file";
  const report = await probeAccess(client, 1);
  assert.equal(report.cleanupOk, false);
  assert.ok(report.advice.some(message => /cleanup could not be confirmed/.test(message)));
});
test("probe refuses to recursively delete unexpected content", async () => {
  const client = new FakeProbeClient();
  client.unexpected = true;
  const report = await probeAccess(client, 1);
  assert.equal(report.cleanupOk, false);
  assert.ok(!client.calls.includes("delete-folder"));
  assert.ok([...client.data.values()].flat().some(item => item.name === "Unrelated.pdf"));
});
test("probe rejects a target not in accessible roots before making changes", async () => {
  const client = new FakeProbeClient();
  await assert.rejects(probeAccess(client, 999), /Choose an accessible root/);
  assert.deepEqual(client.calls, []);
});

test("probe recovers and cleans up an ambiguous create by its unique name", async () => {
  const client = new FakeProbeClient();
  const create = client.createFolder.bind(client);
  client.createFolder = async (parent, name) => {
    await create(parent, name);
    throw new ShufflrrError("network", "Request failed or timed out.");
  };
  const report = await probeAccess(client, 1);
  assert.equal(report.ok, false);
  assert.equal(report.cleanupOk, true);
  assert.deepEqual(await client.contents(1), []);
});

test("probe does not falsely confirm cleanup after an unobservable timed-out write", async () => {
  const client = new FakeProbeClient();
  client.createFolder = async () => { throw new ShufflrrError("network", "Request failed or timed out."); };
  const report = await probeAccess(client, 1);
  assert.equal(report.cleanupOk, false);
  assert.ok(report.advice.some(message => message.includes("cleanup could not be confirmed")));
});
