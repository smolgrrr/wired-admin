import assert from "node:assert/strict";
import test from "node:test";
import {
  RELAY_WORKFLOW_STATUS_LIMITS,
  RELAY_WORKFLOW_STATUS_SCHEMA_VERSION,
  RELAY_WORKFLOW_STATUS_SOURCES,
} from "../contracts/relay-workflow-status.js";

test("admin status adapter shares the approved bounded v1 envelope constants", () => {
  assert.equal(RELAY_WORKFLOW_STATUS_SCHEMA_VERSION, 1);
  assert.deepEqual(RELAY_WORKFLOW_STATUS_SOURCES, [
    "wired-browser",
    "wired-server",
    "wired-admin",
  ]);
  assert.deepEqual(RELAY_WORKFLOW_STATUS_LIMITS, {
    aggregatesPerEnvelope: 100,
    correlationsPerEnvelope: 1,
    envelopeBytes: 32_768,
    queuedEnvelopes: 100,
    rowsPerSourcePerDay: 1_000,
    requestsPerSourcePerMinute: 60,
    previewKeysPerDay: 1_000,
    retentionMs: 14 * 24 * 60 * 60 * 1_000,
  });
});
