import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, Relay } from "nostr-tools";
import { publishNostrEvent } from "../nostr-publisher.js";
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
