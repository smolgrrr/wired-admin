import assert from "node:assert/strict";
import test from "node:test";
import type { RelayWorkflowEvidence } from "../contracts/relay-workflow-evidence.js";
import {
  RELAY_WORKFLOW_STATUS_LIMITS,
  type RelayWorkflowStatusEnvelope,
} from "../contracts/relay-workflow-status.js";
import { RelayWorkflowCollector } from "../evidence/relay-workflow-collector.js";
import { RelayWorkflowEvidenceDispatcher } from "../evidence/relay-workflow-dispatcher.js";
import {
  AdminRelayWorkflowStatusAdapter,
  RelayWorkflowStatusExporter,
  adminWorkflowStatusExportEnabled,
  createAdminWorkflowStatusSink,
} from "../evidence/relay-workflow-exporter.js";
import { publishNostrEvent } from "../nostr-publisher.js";

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

function envelope(collectedAt = 1): RelayWorkflowStatusEnvelope {
  const collector = new RelayWorkflowCollector();
  collector.record(evidence);
  return {
    schemaVersion: 1,
    source: "wired-admin",
    collectedAt,
    aggregates: collector.snapshot(),
    correlations: [],
  };
}

test("admin status exporter caps its queue and recovers after a hung sink", async () => {
  let flush: (() => void) | undefined;
  let attempts = 0;
  const delivered: number[] = [];
  const exporter = new RelayWorkflowStatusExporter(async (item) => {
    attempts += 1;
    if (attempts === 1) await new Promise(() => {});
    delivered.push(item.collectedAt);
  }, {
    schedule: (task) => { flush = task; },
    sinkTimeoutMs: 5,
  });
  for (let index = 0; index < 101; index += 1) {
    exporter.enqueue(envelope(index));
  }
  assert.deepEqual(exporter.status, { enabled: true, pending: 100, dropped: 1 });
  flush?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(exporter.status.pending, 0);
  assert.equal(exporter.status.dropped, 2);
  assert.deepEqual(delivered, Array.from({ length: 99 }, (_, index) => index + 2));
});

test("admin adapter chunks the maximal valid keyspace by exact UTF-8 bytes", async () => {
  const owners = [
    "wired-admin.server.feed-snapshot",
    "wired-admin.server.wired-account-publish",
    "wired-admin.server.confession-publish",
    "wired-admin.server.revenue-receipt-publish",
    "wired-admin.server.revenue-profile-publish",
    "wired-admin.relay-gateway",
  ] as const;
  const operations = ["query", "publish"] as const;
  const outcomes = ["completed", "partial", "timed-out", "cancelled", "failed"] as const;
  const collector = new RelayWorkflowCollector();
  for (const workflowOwner of owners) {
    for (const operation of operations) {
      for (const outcome of outcomes) {
        collector.record({ ...evidence, workflowOwner, operation, outcome });
      }
    }
  }
  const scheduled: Array<() => void> = [];
  const delivered: RelayWorkflowStatusEnvelope[] = [];
  const exporter = new RelayWorkflowStatusExporter(async (item) => {
    delivered.push(item);
  }, { schedule: (task) => { scheduled.push(task); } });
  const adapter = new AdminRelayWorkflowStatusAdapter(collector, exporter, {
    now: () => 123,
  });

  adapter.flushNow();
  scheduled.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.ok(delivered.length > 1);
  assert.equal(delivered.flatMap((item) => item.aggregates).length, 60);
  delivered.forEach((item) => {
    assert.ok(Buffer.byteLength(JSON.stringify(item), "utf8") <=
      RELAY_WORKFLOW_STATUS_LIMITS.envelopeBytes);
  });
});

test("admin adapter seals a collector window on its non-blocking timer", () => {
  let timer: (() => void) | undefined;
  const exporterTasks: Array<() => void> = [];
  const collector = new RelayWorkflowCollector();
  const exporter = new RelayWorkflowStatusExporter(async () => {}, {
    schedule: (task) => { exporterTasks.push(task); },
  });
  const adapter = new AdminRelayWorkflowStatusAdapter(collector, exporter, {
    setTimer: (task) => {
      timer = task;
      return { unref() {} } as NodeJS.Timeout;
    },
    clearTimer() {},
  });
  collector.record(evidence);
  adapter.schedule();
  timer?.();

  assert.deepEqual(collector.snapshot(), []);
  assert.equal(exporter.status.pending, 1);
  assert.equal(exporterTasks.length, 1);
});

test("admin sink uses the configured service identity and navigation-independent timeout", async () => {
  let request: { input: string | URL | Request; init: RequestInit | undefined } | undefined;
  const sink = createAdminWorkflowStatusSink({
    endpoint: "https://wired.example/api/workflow-status",
    token: "operator-secret",
    fetchImpl: async (input, init) => {
      request = { input, init };
      return new Response(null, { status: 202 });
    },
    timeoutMs: 25,
  });
  await sink(envelope());

  assert.equal(request?.input, "https://wired.example/api/workflow-status");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer operator-secret");
  assert.ok(request?.init?.signal instanceof AbortSignal);
  assert.equal(request?.init?.method, "POST");
});

test("admin export rollout is explicit, credentialed, and percentage bounded", () => {
  const env = {
    RELAY_WORKFLOW_STATUS_EXPORT_ENABLED: "true",
    RELAY_WORKFLOW_STATUS_ENDPOINT: "https://wired.example/api/workflow-status",
    WORKFLOW_STATUS_ADMIN_TOKEN: "operator-secret",
    RELAY_WORKFLOW_STATUS_EXPORT_PERCENT: "10",
  } as NodeJS.ProcessEnv;
  assert.equal(adminWorkflowStatusExportEnabled(env, 0.09), true);
  assert.equal(adminWorkflowStatusExportEnabled(env, 0.1), false);
  assert.equal(adminWorkflowStatusExportEnabled({ ...env, WORKFLOW_STATUS_ADMIN_TOKEN: "" }, 0), false);
  assert.equal(adminWorkflowStatusExportEnabled({ ...env, RELAY_WORKFLOW_STATUS_EXPORT_ENABLED: "off" }, 0), false);
});

test("hung export cannot delay or change publication completion", async () => {
  let scheduleCollection = () => {};
  let sealWindow: (() => void) | undefined;
  let flushExport: (() => void) | undefined;
  const collector = new RelayWorkflowCollector({
    onChange: () => { scheduleCollection(); },
  });
  const exporter = new RelayWorkflowStatusExporter(async () => {
    await new Promise(() => {});
  }, {
    schedule: (task) => { flushExport = task; },
    sinkTimeoutMs: 5,
  });
  const adapter = new AdminRelayWorkflowStatusAdapter(collector, exporter, {
    setTimer: (task) => {
      sealWindow = task;
      return { unref() {} } as NodeJS.Timeout;
    },
    clearTimer() {},
  });
  scheduleCollection = () => { adapter.schedule(); };

  const accepted = await publishNostrEvent(
    {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 1,
      tags: [],
      content: "status isolation",
      sig: "c".repeat(128),
    },
    ["wss://relay.example"],
    25,
    {
      evidenceDispatcher: new RelayWorkflowEvidenceDispatcher(collector, (task) => { task(); }),
      connectRelay: async (url) => ({
        url,
        close() {},
        async publish() { return "accepted"; },
      }),
    },
  );

  assert.deepEqual(accepted, ["wss://relay.example"]);
  assert.ok(sealWindow);
  sealWindow?.();
  flushExport?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(exporter.status, { enabled: true, pending: 0, dropped: 1 });
});
