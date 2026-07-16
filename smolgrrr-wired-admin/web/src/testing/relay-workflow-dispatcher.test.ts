import assert from "node:assert/strict";
import test from "node:test";
import { RelayWorkflowCollector } from "../evidence/relay-workflow-collector.js";
import { RelayWorkflowEvidenceDispatcher } from "../evidence/relay-workflow-dispatcher.js";

test("admin evidence dispatcher bounds pending work and reports overflow", () => {
  const collector = new RelayWorkflowCollector();
  let flush: (() => void) | undefined;
  const dispatcher = new RelayWorkflowEvidenceDispatcher(
    collector,
    (task) => { flush = task; },
  );

  for (let index = 0; index < 101; index += 1) {
    dispatcher.defer(() => {});
  }

  assert.deepEqual(dispatcher.status, { pending: 100, dropped: 1 });
  flush?.();
  assert.deepEqual(dispatcher.status, { pending: 0, dropped: 1 });
});

test("admin evidence dispatcher reports scheduler and recorder failures", () => {
  const failingSchedule = new RelayWorkflowEvidenceDispatcher(
    { record() {} },
    () => { throw new Error("scheduler unavailable"); },
  );
  failingSchedule.defer(() => {});
  assert.deepEqual(failingSchedule.status, { pending: 0, dropped: 1 });

  let flush: (() => void) | undefined;
  const failingRecorder = new RelayWorkflowEvidenceDispatcher(
    { record() { throw new Error("collector unavailable"); } },
    (task) => { flush = task; },
  );
  failingRecorder.defer(() => failingRecorder.record({}));
  flush?.();
  assert.deepEqual(failingRecorder.status, { pending: 0, dropped: 1 });
});
