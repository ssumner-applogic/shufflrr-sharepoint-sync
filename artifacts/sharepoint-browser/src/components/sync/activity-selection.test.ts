import { test } from "node:test";
import assert from "node:assert/strict";
import { selectActivityRun } from "./activity-selection";

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
