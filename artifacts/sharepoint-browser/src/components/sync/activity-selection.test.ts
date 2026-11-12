import { test } from "node:test";
import assert from "node:assert/strict";
import { selectActivityRun, selectRunningActivityRun, selectRequestedRetryRun } from "./activity-selection";

const finished = { id: "finished", status: "partial", processed: 56 };
const running = { id: "running", status: "running", processed: 0 };

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
