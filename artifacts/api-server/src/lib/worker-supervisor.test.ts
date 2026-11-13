import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { WorkerSupervisor } from "./worker-supervisor";

const cooperative = `
process.on("SIGTERM", () => { console.log("stopped"); setTimeout(() => process.exit(0), 20); });
process.on("SIGINT", () => { console.log("stopped"); setTimeout(() => process.exit(0), 20); });
console.log("ready");
setInterval(() => {}, 1000);
`;
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function harness(scripts: Record<string, string>, shutdownMs = 1000, stableMs = 10_000) {
  const logs: Record<string, unknown>[] = [];
  const children = new Map<string, { child: ChildProcess; output: string }[]>();
  const log = (fields: Record<string, unknown>) => { logs.push(fields); };
  const supervisor = new WorkerSupervisor({
    workers: Object.entries(scripts).map(([name, script]) => ({ name, args: ["-e", script, name] })),
    logger: { info: log, warn: log, error: log },
    shutdownMs, restartBaseMs: 20, restartMaxMs: 60, stableMs,
    spawnWorker: args => {
      // These tiny local process fixtures never read credentials or call providers.
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      const record = { child, output: "" };
      const list = children.get(args[2]!) ?? [];
      list.push(record);
      children.set(args[2]!, list);
      child.stdout?.on("data", chunk => { record.output += String(chunk); });
      child.stderr?.resume();
      return child;
    },
  });
  supervisor.start();
  return { supervisor, logs, children };
}

test("starts two distinct processes and stops both gracefully without restarting", async () => {
  const h = harness({ file: cooperative, metadata: cooperative });
  try {
    await until(() => [...h.children.values()].every(list => list[0]!.output.includes("ready")), "Both workers must be ready");
    const file = h.children.get("file")![0]!;
    const metadata = h.children.get("metadata")![0]!;
    assert.notEqual(file.child.pid, metadata.child.pid);
    assert.deepEqual(await h.supervisor.stop(), { forced: false });
    assert.ok(file.output.includes("stopped"));
    assert.ok(metadata.output.includes("stopped"));
    assert.equal(h.logs.filter(log => log.event === "worker_restart_scheduled").length, 0);
    assert.equal(h.logs.filter(log => log.event === "worker_exited").length, 2);
  } finally { await h.supervisor.stop(); }
});

for (const crashing of ["file", "metadata"]) {
  test(`restarts only ${crashing} after a crash; the other worker keeps its PID`, async () => {
    const h = harness({ file: cooperative, metadata: cooperative });
    try {
      await until(() => [...h.children.values()].every(list => list[0]!.output.includes("ready")), "Workers must be ready");
      const other = crashing === "file" ? "metadata" : "file";
      const peer = h.children.get(other)![0]!.child;
      h.children.get(crashing)![0]!.child.kill("SIGKILL");
      await until(() => h.children.get(crashing)?.[1]?.output.includes("ready") === true, "Crashed worker must restart");
      assert.equal(h.children.get(other)!.length, 1);
      assert.equal(peer.exitCode, null);
      assert.equal(peer.signalCode, null);
      assert.notEqual(h.children.get(crashing)![0]!.child.pid, h.children.get(crashing)![1]!.child.pid);
    } finally { await h.supervisor.stop(); }
  });
}

test("unexpected successful exits also restart, with capped exponential backoff", async () => {
  const h = harness({ file: cooperative, metadata: "process.exit(0);" });
  try {
    await until(() => h.logs.filter(log => log.event === "worker_restart_scheduled").length >= 4, "Backoff must be recorded");
    const scheduled = h.logs.filter(log => log.event === "worker_restart_scheduled" && log.worker === "metadata");
    assert.deepEqual(scheduled.slice(0, 4).map(log => log.delayMs), [20, 40, 60, 60]);
    assert.ok(h.logs.filter(log => log.event === "worker_exited" && log.worker === "metadata")
      .every(log => log.exitCode === 0));
    assert.equal(h.children.get("file")!.length, 1);
  } finally { await h.supervisor.stop(); }
});

test("shutdown cancels a pending restart and repeated stop calls are harmless", async () => {
  const h = harness({ file: cooperative, metadata: "process.exit(1);" });
  try {
    await until(() => h.logs.some(log => log.event === "worker_restart_scheduled"), "Restart must be pending");
    const count = h.children.get("metadata")!.length;
    const stopped = h.supervisor.stop();
    assert.equal(h.supervisor.stop("SIGINT"), stopped);
    await stopped;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(h.children.get("metadata")!.length, count);
    h.supervisor.start();
    assert.equal(h.children.get("file")!.length, 1);
  } finally { await h.supervisor.stop(); }
});

test("a stable worker resets its restart backoff after an earlier crash", async () => {
  const h = harness({ metadata: cooperative }, 1000, 100);
  try {
    await until(() => h.children.get("metadata")?.[0]?.output.includes("ready") === true, "Worker must be ready");
    h.children.get("metadata")![0]!.child.kill("SIGKILL");
    await until(() => h.children.get("metadata")?.[1]?.output.includes("ready") === true, "Worker must restart");
    await new Promise(resolve => setTimeout(resolve, 150));
    h.children.get("metadata")![1]!.child.kill("SIGKILL");
    await until(() => h.logs.filter(log => log.event === "worker_restart_scheduled").length >= 2, "Second restart must be recorded");
    assert.deepEqual(h.logs.filter(log => log.event === "worker_restart_scheduled").map(log => log.delayMs), [20, 20]);
  } finally { await h.supervisor.stop(); }
});

test("SIGINT reaches both children and completes their cleanup", async () => {
  const h = harness({ file: cooperative, metadata: cooperative });
  try {
    await until(() => [...h.children.values()].every(list => list[0]!.output.includes("ready")), "Workers must be ready");
    assert.deepEqual(await h.supervisor.stop("SIGINT"), { forced: false });
    assert.ok([...h.children.values()].every(list => list[0]!.output.includes("stopped")));
  } finally { await h.supervisor.stop(); }
});

test("forces only an unresponsive child to stop after the grace period", async () => {
  const unresponsive = 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';
  const h = harness({ file: cooperative, metadata: unresponsive }, 200);
  try {
    await until(() => [...h.children.values()].every(list => list[0]!.output.includes("ready")), "Workers must be ready");
    assert.deepEqual(await h.supervisor.stop(), { forced: true });
    assert.equal(h.children.get("file")![0]!.child.exitCode, 0);
    assert.equal(h.children.get("metadata")![0]!.child.signalCode, "SIGKILL");
    assert.deepEqual(h.logs.filter(log => log.event === "worker_shutdown_timeout").map(log => log.worker), ["metadata"]);
  } finally { await h.supervisor.stop(); }
});

test("launch errors back off and remain isolated from a healthy worker", async () => {
  const logs: Record<string, unknown>[] = [];
  let file: ChildProcess | undefined;
  const log = (fields: Record<string, unknown>) => { logs.push(fields); };
  const supervisor = new WorkerSupervisor({
    workers: [{ name: "file", args: ["-e", cooperative] }, { name: "metadata", args: [] }],
    logger: { info: log, warn: log, error: log },
    restartBaseMs: 30, restartMaxMs: 60, shutdownMs: 1000,
    spawnWorker: args => {
      if (!args.length) return spawn("/nonexistent-worker-executable", [], { stdio: "ignore" });
      file = spawn(process.execPath, args, { stdio: "ignore" });
      return file;
    },
  });
  try {
    supervisor.start();
    await until(() => logs.filter(log => log.event === "worker_restart_scheduled").length >= 2, "Failed launches must retry");
    assert.equal(file?.exitCode, null);
    assert.ok(logs.some(log => log.event === "worker_process_error" && log.worker === "metadata"));
  } finally { await supervisor.stop(); }
});

test("rejects ambiguous workers and invalid supervision timings", () => {
  const logger = { info() {}, warn() {}, error() {} };
  assert.throws(() => new WorkerSupervisor({ workers: [], logger }));
  assert.throws(() => new WorkerSupervisor({ workers: [{ name: "same", args: [] }, { name: "same", args: [] }], logger }));
  assert.throws(() => new WorkerSupervisor({ workers: [{ name: "worker", args: [] }], logger, shutdownMs: 0 }));
});

test("synchronous launch failures do not leak details or prevent another worker starting", async () => {
  const logs: Record<string, unknown>[] = [];
  let peerStarted = false;
  const log = (fields: Record<string, unknown>) => { logs.push(fields); };
  const supervisor = new WorkerSupervisor({
    workers: [{ name: "metadata", args: [] }, { name: "file", args: ["-e", cooperative] }],
    logger: { info: log, warn: log, error: log },
    shutdownMs: 1000,
    spawnWorker: args => {
      if (!args.length) throw new Error("private-launch-detail");
      peerStarted = true;
      return spawn(process.execPath, args, { stdio: "ignore" });
    },
  });
  try {
    supervisor.start();
    assert.ok(peerStarted);
    assert.ok(logs.some(log => log.event === "worker_spawn_failed" && log.worker === "metadata"));
    assert.ok(!JSON.stringify(logs).includes("private-launch-detail"));
  } finally { await supervisor.stop(); }
});
