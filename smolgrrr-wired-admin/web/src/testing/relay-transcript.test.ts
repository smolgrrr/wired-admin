import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, Relay } from "nostr-tools";
import {
  getServerRelayWorkflowEvidence,
  publishNostrEvent,
  type RelayConnector,
} from "../nostr-publisher.js";
import { RelayWorkflowCollector } from "../evidence/relay-workflow-collector.js";
import { RelayWorkflowEvidenceDispatcher } from "../evidence/relay-workflow-dispatcher.js";
import {
  AdminRelayWorkflowStatusAdapter,
  RelayWorkflowStatusExporter,
} from "../evidence/relay-workflow-exporter.js";
import {
  RelayTranscriptHarness,
  RelayTranscriptSession,
  type RelayPublishController,
  type RelayRequestController,
} from "./relay-transcript.js";

const event = finalizeEvent({
  created_at: 1_700_000_000,
  kind: 1,
  tags: [],
  content: "transcript fixture",
}, new Uint8Array(32).fill(3));

test("relay transcript records publish rejection, retry, and acknowledgement", async () => {
  const session = new RelayTranscriptSession();
  const acceptedHarness = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish: RelayPublishController) {
      publish.acknowledge(true);
    },
  });
  let rejectedAttempts = 0;
  const rejectedHarness = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish: RelayPublishController) {
      rejectedAttempts += 1;
      publish.acknowledge(
        rejectedAttempts > 1,
        rejectedAttempts > 1 ? "" : "rate-limited: retry",
      );
    },
  });

  try {
    const workflow = session.beginWorkflow("publish-retry");
    assert.deepEqual(
      await publishNostrEvent(
        event,
        [acceptedHarness.url, rejectedHarness.url],
        1_000,
      ),
      [acceptedHarness.url],
    );
    workflow.recordRetry(`EVENT:${event.id}:${rejectedHarness.url}`);
    assert.deepEqual(
      await publishNostrEvent(event, [rejectedHarness.url], 1_000),
      [rejectedHarness.url],
    );
    workflow.complete();

    const summary = session.summary(workflow);
    assert.deepEqual({
      openedConnections: summary.openedConnections,
      publishes: summary.publishes,
      acknowledgements: summary.acknowledgements,
      rejections: summary.rejections,
      retries: summary.retries,
      repeatedOperations: summary.repeatedOperations,
      relayFanout: summary.relayFanout,
    }, {
      openedConnections: 3,
      publishes: 3,
      acknowledgements: 2,
      rejections: 1,
      retries: 1,
      repeatedOperations: 2,
      relayFanout: 2,
    });
    assert.ok(summary.publishedEventBytes > 0);

    const frozenSummary = session.summary(workflow);
    workflow.recordRetry("after-completion");
    assert.deepEqual(session.summary(workflow), frozenSummary);
  } finally {
    await Promise.all([acceptedHarness.close(), rejectedHarness.close()]);
  }
});

test("publisher measures partial acceptance and fresh connection cleanup", async () => {
  const session = new RelayTranscriptSession();
  const accept = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish) {
      publish.acknowledge(true, "", 5);
    },
  });
  const secondAccept = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish) {
      publish.acknowledge(true, "", 5);
    },
  });
  const reject = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish) {
      publish.acknowledge(false, "blocked", 5);
    },
  });
  const collector = new RelayWorkflowCollector();
  let flushEvidence: (() => void) | undefined;
  const dispatcher = new RelayWorkflowEvidenceDispatcher(
    collector,
    (task) => { flushEvidence = task; },
  );

  try {
    const sampleCount = process.env.RELAY_AUDIT_OUTPUT === "1" ? 20 : 1;
    const completionLatencies: number[] = [];
    let evidencePublishedEventBytes: number[] = [];
    for (let run = 0; run < sampleCount; run += 1) {
      const workflow = session.beginWorkflow(`admin-publish-partial-${run + 1}`);
      assert.deepEqual(
        await publishNostrEvent(event, [accept.url, secondAccept.url, reject.url], 1_000, {
          evidenceDispatcher: dispatcher,
          workflowOwner: "wired-admin.server.wired-account-publish",
        }),
        [accept.url, secondAccept.url].sort(),
      );
      flushEvidence?.();
      await session.waitFor((entries) =>
        entries.filter((entry) => entry.type === "connection-closed").length ===
          (run + 1) * 3,
      );
      workflow.complete();
      const summary = session.summary(workflow);
      assert.deepEqual({
        openedConnections: summary.openedConnections,
        closedConnections: summary.closedConnections,
        publishes: summary.publishes,
        acknowledgements: summary.acknowledgements,
        rejections: summary.rejections,
        retries: summary.retries,
        repeatedOperations: summary.repeatedOperations,
        relayFanout: summary.relayFanout,
      }, {
        openedConnections: 3,
        closedConnections: 3,
        publishes: 3,
        acknowledgements: 2,
        rejections: 1,
        retries: 0,
        repeatedOperations: 2,
        relayFanout: 3,
      });
      completionLatencies.push(summary.completionLatencyMs);
      evidencePublishedEventBytes = session.entries
        .slice(workflow.startIndex, workflow.completedIndex)
        .filter((entry) => entry.type === "publish")
        .map((entry) => entry.bytes);
    }

    if (process.env.RELAY_AUDIT_OUTPUT === "1") {
      const sorted = [...completionLatencies].sort((left, right) => left - right);
      const percentile = (value: number) =>
        sorted[Math.ceil((value / 100) * sorted.length) - 1] ?? 0;
      console.info(JSON.stringify({
        scenario: "wired-admin-publish-partial-local-fixture",
        samples: sampleCount,
        completionLatencyMs: {
          p50: percentile(50),
          p95: percentile(95),
          samples: completionLatencies,
        },
        evidence: { publishedEventBytes: evidencePublishedEventBytes },
      }));
    }
    const aggregate = collector.snapshot()[0];
    assert.equal(aggregate?.samples, sampleCount);
    assert.equal(aggregate?.outcome, "partial");
    assert.equal(aggregate?.totals.targets, 3 * sampleCount);
    assert.equal(aggregate?.totals.eventsPublished, 3 * sampleCount);
    assert.equal(aggregate?.totals.rejected, sampleCount);
    assert.equal(aggregate?.totals.ownerRetries, 0);
    assert.equal(aggregate?.acceptedCountBuckets.multiple, sampleCount);
  } finally {
    await Promise.all([accept.close(), secondAccept.close(), reject.close()]);
  }
});

test("publisher bounds a silent relay and tolerates a disconnected relay", async () => {
  const session = new RelayTranscriptSession();
  const accept = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish) {
      publish.acknowledge(true, "", 5);
    },
  });
  const silent = await RelayTranscriptHarness.listen({ session, onPublish() {} });
  const disconnected = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish) {
      publish.closeConnection(5);
    },
  });

  try {
    const workflow = session.beginWorkflow("admin-publish-timeout-disconnect");
    assert.deepEqual(
      await publishNostrEvent(event, [accept.url, silent.url, disconnected.url], 50),
      [accept.url],
    );
    await session.waitFor((entries) =>
      entries.filter((entry) => entry.type === "connection-closed").length === 3
    );
    workflow.complete();
    const summary = session.summary(workflow);
    assert.equal(summary.publishes, 3);
    assert.equal(summary.acknowledgements, 1);
    assert.equal(summary.rejections, 0);
    assert.equal(summary.closedConnections, 3);
    assert.ok(summary.completionLatencyMs >= 50);
  } finally {
    await Promise.all([accept.close(), silent.close(), disconnected.close()]);
  }
});

test("publisher collection modes preserve results and controlled p95", async () => {
  const session = new RelayTranscriptSession();
  const accept = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish) { publish.acknowledge(true, "", 5); },
  });
  const reject = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish) { publish.acknowledge(false, "blocked", 5); },
  });
  let scheduleExport = () => {};
  const exportCollector = new RelayWorkflowCollector({
    onChange: () => { scheduleExport(); },
  });
  const exportAdapter = new AdminRelayWorkflowStatusAdapter(
    exportCollector,
    new RelayWorkflowStatusExporter(async () => {}),
    {
      setTimer: () => ({ unref() {} }) as NodeJS.Timeout,
      clearTimer() {},
    },
  );
  scheduleExport = () => { exportAdapter.schedule(); };
  const variants = [
    { name: "disabled", dispatcher: null },
    {
      name: "enabled",
      dispatcher: new RelayWorkflowEvidenceDispatcher(new RelayWorkflowCollector()),
    },
    {
      name: "export-scheduled",
      dispatcher: new RelayWorkflowEvidenceDispatcher(exportCollector),
    },
    {
      name: "full",
      dispatcher: new RelayWorkflowEvidenceDispatcher(
        new RelayWorkflowCollector({ counterLimit: 1 }),
      ),
    },
    {
      name: "failing",
      dispatcher: new RelayWorkflowEvidenceDispatcher({
        record() { throw new Error("collector unavailable"); },
      }),
    },
  ];
  const p95ByVariant = new Map<string, number>();
  const latenciesByVariant = new Map(
    variants.map((variant) => [variant.name, [] as number[]]),
  );

  try {
    for (let run = 0; run < 20; run += 1) {
      for (const variant of variants) {
        const workflow = session.beginWorkflow(`${variant.name}-${run}`);
        assert.deepEqual(await publishNostrEvent(
          event,
          [accept.url, reject.url],
          1_000,
          { evidenceDispatcher: variant.dispatcher },
        ), [accept.url]);
        workflow.complete();
        latenciesByVariant.get(variant.name)?.push(
          session.summary(workflow).completionLatencyMs,
        );
      }
    }
    for (const variant of variants) {
      const latencies = latenciesByVariant.get(variant.name) ?? [];
      const sorted = [...latencies].sort((left, right) => left - right);
      p95ByVariant.set(variant.name, sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0);
    }

    const disabledP95 = p95ByVariant.get("disabled") ?? 0;
    if (process.env.RELAY_AUDIT_OUTPUT === "1") {
      assert.equal([...p95ByVariant.values()].every((p95) => p95 <= 21), true);
      assert.equal(
        [...p95ByVariant.values()].every((p95) => p95 <= disabledP95 + 5),
        true,
      );
      console.info(JSON.stringify({
        scenario: "wired-admin-publish-instrumentation-local-fixture",
        samplesPerVariant: 20,
        completionP95Ms: Object.fromEntries(p95ByVariant),
      }));
    }
  } finally {
    await Promise.all([accept.close(), reject.close()]);
  }
});

test("production evidence collection can be disabled without changing publication", async () => {
  const previous = process.env.RELAY_WORKFLOW_EVIDENCE_ENABLED;
  const before = getServerRelayWorkflowEvidence();
  process.env.RELAY_WORKFLOW_EVIDENCE_ENABLED = "off";
  try {
    assert.deepEqual(await publishNostrEvent(event, ["wss://disabled.example"], 25, {
      connectRelay: async (url) => ({
        url,
        close() {},
        async publish() { return "accepted"; },
      }),
    }), ["wss://disabled.example"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(getServerRelayWorkflowEvidence(), before);
  } finally {
    if (previous === undefined) {
      delete process.env.RELAY_WORKFLOW_EVIDENCE_ENABLED;
    } else {
      process.env.RELAY_WORKFLOW_EVIDENCE_ENABLED = previous;
    }
  }
});

test("publisher closes a relay that finishes connecting after its deadline", async () => {
  let closes = 0;
  let publishes = 0;
  const collector = new RelayWorkflowCollector();
  const evidenceTasks: Array<() => void> = [];
  const dispatcher = new RelayWorkflowEvidenceDispatcher(
    collector,
    (task) => { evidenceTasks.push(task); },
  );

  assert.deepEqual(await publishNostrEvent(event, ["wss://late.example"], 5, {
    evidenceDispatcher: dispatcher,
    async connectRelay(url) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        url,
        close() {
          closes += 1;
        },
        async publish() {
          publishes += 1;
          return "accepted";
        },
      };
    },
  }), []);
  evidenceTasks.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 35));
  evidenceTasks.shift()?.();

  assert.equal(publishes, 0);
  assert.equal(closes, 1);
  const aggregate = collector.snapshot()[0];
  assert.equal(aggregate?.outcome, "timed-out");
  assert.equal(aggregate?.totals.lateConnectionsClosed, 1);
});

test("publisher isolates synchronous connector failures and records observed outcomes", async () => {
  const collector = new RelayWorkflowCollector();
  const evidenceTasks: Array<() => void> = [];
  const dispatcher = new RelayWorkflowEvidenceDispatcher(
    collector,
    (task) => { evidenceTasks.push(task); },
  );
  let acceptedCloses = 0;

  assert.deepEqual(await publishNostrEvent(
    event,
    ["wss://throws.example", "wss://accepts.example"],
    25,
    {
      evidenceDispatcher: dispatcher,
      connectRelay(url) {
        if (url.includes("throws")) throw new Error("connector unavailable");
        return Promise.resolve({
          url,
          close() { acceptedCloses += 1; },
          async publish() { return "accepted"; },
        });
      },
    },
  ), ["wss://accepts.example"]);
  evidenceTasks.shift()?.();

  const aggregate = collector.snapshot()[0];
  assert.equal(acceptedCloses, 1);
  assert.equal(aggregate?.outcome, "partial");
  assert.equal(aggregate?.totals.connectFailed, 1);
  assert.equal(aggregate?.totals.connectionsOpened, 1);
  assert.equal(aggregate?.totals.connectionsClosed, 1);
  assert.equal(aggregate?.totals.eventsPublished, 1);
  assert.equal(aggregate?.totals.ownerRetries, 0);
});

test("publisher records an owner-declared retry only after a real repeated attempt", async () => {
  const collector = new RelayWorkflowCollector();
  const evidenceTasks: Array<() => void> = [];
  const dispatcher = new RelayWorkflowEvidenceDispatcher(
    collector,
    (task) => { evidenceTasks.push(task); },
  );
  let attempts = 0;
  const connectRelay: RelayConnector = async (url) => ({
      url,
      close() {},
      async publish() {
        attempts += 1;
        if (attempts === 1) throw new Error("rate limited");
        return "accepted";
      },
    });

  assert.deepEqual(await publishNostrEvent(event, ["wss://retry.example"], 25, {
    connectRelay,
    evidenceDispatcher: dispatcher,
  }), []);
  evidenceTasks.shift()?.();
  assert.deepEqual(await publishNostrEvent(event, ["wss://retry.example"], 25, {
    connectRelay,
    evidenceDispatcher: dispatcher,
    ownerRetries: 1,
  }), ["wss://retry.example"]);
  evidenceTasks.shift()?.();

  const completed = collector.snapshot().find((entry) => entry.outcome === "completed");
  assert.equal(completed?.samples, 1);
  assert.equal(completed?.totals.ownerRetries, 1);
  assert.equal(completed?.totals.eventsPublished, 1);
});

test("publisher aggregate distinguishes rejection, timeout, and disconnect terminals", async () => {
  const scenarios = [
    {
      url: "wss://rejected.example",
      connected: true,
      publish: async () => { throw new Error("blocked"); },
      outcome: "failed",
      rejected: 1,
      timedOut: 0,
      terminalClosed: 0,
    },
    {
      url: "wss://timeout.example",
      connected: true,
      publish: () => new Promise<string>(() => {}),
      outcome: "timed-out",
      rejected: 0,
      timedOut: 1,
      terminalClosed: 0,
    },
    {
      url: "wss://disconnect.example",
      connected: false,
      publish: async () => { throw new Error("connection closed"); },
      outcome: "failed",
      rejected: 0,
      timedOut: 0,
      terminalClosed: 1,
    },
  ] as const;

  for (const scenario of scenarios) {
    const collector = new RelayWorkflowCollector();
    let flushEvidence: (() => void) | undefined;
    const dispatcher = new RelayWorkflowEvidenceDispatcher(
      collector,
      (task) => { flushEvidence = task; },
    );
    assert.deepEqual(await publishNostrEvent(event, [scenario.url], 5, {
      evidenceDispatcher: dispatcher,
      connectRelay: async (url) => ({
        url,
        connected: scenario.connected,
        close() {},
        publish: scenario.publish,
      }),
    }), []);
    flushEvidence?.();

    const aggregate = collector.snapshot()[0];
    assert.equal(aggregate?.outcome, scenario.outcome);
    assert.equal(aggregate?.totals.eventsPublished, 1);
    assert.equal(aggregate?.totals.rejected, scenario.rejected);
    assert.equal(aggregate?.totals.timedOut, scenario.timedOut);
    assert.equal(aggregate?.totals.terminalClosed, scenario.terminalClosed);
    assert.equal(aggregate?.totals.connectionsClosed, 1);
  }
});

test("publisher deduplicates normalized targets within each invocation", async () => {
  const session = new RelayTranscriptSession();
  const harness = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish) {
      publish.acknowledge(true);
    },
  });

  try {
    const workflow = session.beginWorkflow("admin-publish-duplicates");
    const [first, duplicate] = await Promise.all([
      publishNostrEvent(event, [harness.url, `${harness.url}/`], 1_000),
      publishNostrEvent(event, [harness.url], 1_000),
    ]);
    await session.waitFor((entries) =>
      entries.filter((entry) => entry.type === "connection-closed").length === 2
    );
    workflow.complete();

    assert.deepEqual(first, [harness.url]);
    assert.deepEqual(duplicate, [harness.url]);
    assert.deepEqual({
      openedConnections: session.summary(workflow).openedConnections,
      closedConnections: session.summary(workflow).closedConnections,
      publishes: session.summary(workflow).publishes,
      acknowledgements: session.summary(workflow).acknowledgements,
      repeatedOperations: session.summary(workflow).repeatedOperations,
      relayFanout: session.summary(workflow).relayFanout,
    }, {
      openedConnections: 2,
      closedConnections: 2,
      publishes: 2,
      acknowledgements: 2,
      repeatedOperations: 1,
      relayFanout: 1,
    });
  } finally {
    await harness.close();
  }
});

test("relay transcript exposes a client timeout as CLOSE without relay EOSE", async () => {
  const harness = await RelayTranscriptHarness.listen();

  try {
    const workflow = harness.beginWorkflow("query-timeout");
    const relay = await Relay.connect(harness.url);
    await new Promise<void>((resolve) => {
      const subscription = relay.subscribe([{ kinds: [1] }], {
        eoseTimeout: 20,
        oneose() {
          subscription.close();
          resolve();
        },
      });
    });
    await harness.waitFor(
      (entries) => entries.some((entry) => entry.type === "close"),
    );
    workflow.complete();
    relay.close();

    const summary = harness.summary(workflow);
    assert.equal(summary.requests, 1);
    assert.equal(summary.eose, 0);
    assert.equal(summary.closes, 1);
    assert.equal(summary.subscriptionLifetimesMs.length, 1);
    assert.ok((summary.subscriptionLifetimesMs[0] ?? 0) >= 0);
  } finally {
    await harness.close();
  }
});

test("relay transcript drives delayed events and relay failure deterministically", async () => {
  const harness = await RelayTranscriptHarness.listen({
    onRequest(request: RelayRequestController) {
      request.sendEvent(event, 5);
      request.closeConnection(10);
    },
  });

  try {
    const workflow = harness.beginWorkflow("delayed-relay-failure");
    const relay = await Relay.connect(harness.url);
    const receivedIds: string[] = [];
    relay.subscribe([{ kinds: [1] }], {
      eoseTimeout: 20,
      onevent(received) {
        receivedIds.push(received.id);
      },
    });

    await harness.waitFor(
      (entries) => entries.some((entry) => entry.type === "connection-closed"),
    );
    workflow.complete();

    assert.deepEqual(receivedIds, [event.id]);
    assert.equal(harness.summary(workflow).returnedEvents, 1);
    assert.equal(harness.summary(workflow).closedConnections, 1);
    assert.equal(harness.summary(workflow).eose, 0);
  } finally {
    await harness.close();
  }
});
