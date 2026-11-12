import { test } from "node:test";
import assert from "node:assert/strict";
import { selectActivityRun, selectRunningActivityRun, selectRequestedRetryRun, selectLatestFileTransferRun } from "./activity-selection";

const finished = { id: "finished", status: "partial", processed: 56 };
const running = { id: "running", status: "running", processed: 0 };

function transferRun(id: string, minute: number, copiedFiles: number, updatedFiles = 0, status = "success") {
  const time = new Date(Date.UTC(2026, 10, 12, 20, minute)).toISOString();
  return { id, startedAt: time, finishedAt: time, status, summary: { copiedFiles, updatedFiles } };
}

test("later no-change runs cannot hide the most recent file creation", () => {
  const created = transferRun("created", 39, 2);
  const noChanges = transferRun("no-changes", 43, 0);
  assert.equal(selectLatestFileTransferRun([noChanges, created]), created);
  assert.equal(selectLatestFileTransferRun([created, noChanges]), created);
});

test("a later completed update takes precedence, including applied work in partial runs", () => {
  const created = transferRun("created", 39, 2);
  const updated = transferRun("updated", 44, 0, 1, "partial");
  assert.equal(selectLatestFileTransferRun([created, updated]), updated);
});

test("unconfirmed running transfers and legacy empty summaries do not claim completion", () => {
  const live = { ...transferRun("live", 45, 1, 0, "running"), finishedAt: null };
  const legacy = { ...transferRun("legacy", 39, 0), summary: null };
  assert.equal(selectLatestFileTransferRun([live, legacy, transferRun("noop", 46, 0)]), null);
});

test("new runs cannot reset a pinned completed activity log", () => {
  assert.equal(selectActivityRun([running, finished], finished.id, false), finished);
});
test("a pinned running run continues updating without switching identities", () => {
  const next = { ...running, processed: 42 };
  assert.equal(selectActivityRun([next, finished], running.id, false), next);
});
test("only explicitly following latest selects each newly started run", () => {
  assert.equal(selectActivityRun([running, finished], finished.id, true), running);
});
test("initial selection uses latest, while a removed selection is not silently replaced", () => {
  assert.equal(selectActivityRun([running], null, false), running);
  assert.equal(selectActivityRun([running], finished.id, false), null);
  assert.equal(selectActivityRun([], null, false), null);
});

test("live progress comes from the running job while historical detail remains pinned", () => {
  const live = { ...running, processed: 17 };
  const runs = [live, finished];
  assert.equal(selectActivityRun(runs, finished.id, false), finished);
  assert.equal(selectRunningActivityRun(runs), live);
  assert.equal(selectRunningActivityRun(runs)?.processed, 17);
});

test("live execution clears when the job finishes, without starting or selecting another job", () => {
  assert.equal(selectRunningActivityRun([{ ...running, status: "success" }, finished]), null);
  assert.equal(selectRunningActivityRun([]), null);
});

test("a retry request selects its first retry job, not an older retry or a later full sync", () => {
  const retry = (id: string, seconds: number) => ({ id,
    startedAt: new Date(seconds * 1000).toISOString(), summary: { runKind: "retry" }, status: "partial" });
  const target = retry("requested-group", 12);
  const laterFull = { ...retry("scheduled", 20), summary: { runKind: "full" } };
  const list = [laterFull, retry("later-retry", 18), target, retry("old-retry", 8)];
  const selected = selectRequestedRetryRun(list, new Date(10_000).toISOString());
  assert.equal(selected, target);
  assert.equal(selectActivityRun(list, selected!.id, false), target, "A later scheduled run cannot replace the pinned result");
  assert.equal(selectRunningActivityRun([{ ...laterFull, status: "running" }, target])?.id, laterFull.id);
});

test("queued retry selection waits for a matching job and tolerates legacy summaries", () => {
  const full = { startedAt: new Date(20_000).toISOString(), summary: { runKind: "full" } };
  assert.equal(selectRequestedRetryRun([full, { ...full, summary: null }], new Date(10_000).toISOString()), null);
  assert.equal(selectRequestedRetryRun([full], null), null);
  assert.equal(selectRequestedRetryRun([full], "invalid"), null);
});
