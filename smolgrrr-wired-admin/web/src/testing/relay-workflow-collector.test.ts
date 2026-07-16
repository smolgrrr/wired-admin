import assert from "node:assert/strict";
import test from "node:test";
import type { RelayWorkflowEvidence } from "../contracts/relay-workflow-evidence.js";
import { RelayWorkflowCollector } from "../evidence/relay-workflow-collector.js";

const evidence = {
  schemaVersion: 1,
  workflowOwner: "wired-admin.server.wired-account-publish",
  operation: "publish",
  outcome: "partial",
  work: { attempts: 1, targets: 2 },
  connections: { opened: 2, closed: 2, reused: 0, lateClosed: 0 },
  relay: {
    requestsSent: 0, eventsPublished: 2, eventsReceived: 0,
    requestBytes: 0, eventBytesSent: 740, eventBytesReceived: 0,
  },
  results: { unique: 0, duplicates: 0, coalescedOperations: 0 },
  terminal: { eose: 0, closed: 0, connectFailed: 0, timedOut: 0, cancelled: 0 },
  publishing: { acceptedCountBucket: "one", rejected: 1, ownerRetries: 0 },
  timingMs: { firstResult: null, completion: 21 },
} satisfies RelayWorkflowEvidence;

test("admin collector aggregates fixed bounded fields", () => {
  const collector = new RelayWorkflowCollector({ counterLimit: 2 });
  collector.record(evidence);
  collector.record(evidence);
  collector.record(evidence);
  collector.record({ ...evidence, relayUrl: "wss://forbidden.example" });

  assert.equal(collector.snapshot()[0]?.samples, 2);
  assert.equal(collector.snapshot()[0]?.overflowed, 1);
  assert.equal(collector.snapshot()[0]?.totals.targets, 2);
  assert.equal(collector.invalidCount, 1);
});

test("admin collector normalizes invalid counter limits", () => {
  const collector = new RelayWorkflowCollector({ counterLimit: Number.NaN });
  collector.record(evidence);
  assert.equal(collector.snapshot()[0]?.samples, 1);
});

test("admin collector drains sealed windows and isolates export scheduling", () => {
  let changes = 0;
  const collector = new RelayWorkflowCollector({
    onChange() {
      changes += 1;
      throw new Error("export scheduler unavailable");
    },
  });
  assert.doesNotThrow(() => collector.record(evidence));
  assert.equal(changes, 1);
  assert.equal(collector.drain().length, 1);
  assert.deepEqual(collector.snapshot(), []);
});

test("admin collector carries a late cleanup into the next sealed window", () => {
  const collector = new RelayWorkflowCollector();
  collector.record(evidence);
  assert.equal(collector.drain().length, 1);

  collector.recordLateConnectionClosed({
    workflowOwner: evidence.workflowOwner,
    operation: evidence.operation,
    outcome: evidence.outcome,
  });

  assert.equal(collector.snapshot()[0]?.samples, 0);
  assert.equal(collector.snapshot()[0]?.totals.lateConnectionsClosed, 1);
});
