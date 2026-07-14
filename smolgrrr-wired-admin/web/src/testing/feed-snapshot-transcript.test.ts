import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeEvent } from "nostr-tools";
import { createFeedSnapshotService } from "../feed-snapshot-service.js";
import { createModerationService } from "../moderation.js";
import {
  RelayTranscriptHarness,
  type RelayRequestController,
} from "./relay-transcript.js";

const secretKey = new Uint8Array(32).fill(2);
const rootEvent = finalizeEvent({
  created_at: 2_000_000_000,
  kind: 1,
  tags: [],
  content: "root",
}, secretKey);
const replyEvent = finalizeEvent({
  created_at: rootEvent.created_at,
  kind: 1,
  tags: [["e", rootEvent.id, "", "reply"]],
  content: "reply",
}, secretKey);

test("feed snapshot exposes complete output and its relay transcript", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "wired-relay-transcript-"));
  let harness: RelayTranscriptHarness | undefined;

  try {
    harness = await RelayTranscriptHarness.listen({
      onRequest(request: RelayRequestController) {
        const [filter] = request.filters;
        if (filter?.["#e"]?.includes(rootEvent.id)) {
          request.sendEvent(replyEvent);
        } else if (filter?.kinds?.includes(1) && !filter.ids) {
          request.sendEvent(rootEvent);
        }
        request.sendEose();
      },
    });
    const workflow = harness.beginWorkflow("feed-snapshot");
    const service = createFeedSnapshotService({
      cacheFile: path.join(temporaryDirectory, "feed.json"),
      refreshSeconds: 300,
      ageHours: 24,
      timeoutMs: 1_000,
      replyLimit: 100,
      replyFetchDepth: 1,
      minPow: 0,
      powRelays: [harness.url],
      enrichmentRelays: [harness.url],
      threadRelays: [harness.url],
      moderation: createModerationService(path.join(temporaryDirectory, "moderation.json")),
    });

    const refreshStartedAt = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const snapshot = await service.refresh();
    const refreshCompletedAt = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    await harness.waitFor(
      (entries) => entries.filter((entry) => entry.type === "close").length === 3,
    );
    workflow.complete();

    assert.deepEqual(Object.keys(snapshot.eventsById).sort(), [
      replyEvent.id,
      rootEvent.id,
    ].sort());
    assert.deepEqual(snapshot.processedEvents[0]?.replyIds, [replyEvent.id]);
    const summary = harness.summary(workflow);
    assert.deepEqual({
      workflow: summary.workflow,
      openedConnections: summary.openedConnections,
      closedConnections: summary.closedConnections,
      connectionReuseCount: summary.connectionReuseCount,
      requests: summary.requests,
      closes: summary.closes,
      returnedEvents: summary.returnedEvents,
      eose: summary.eose,
      publishes: summary.publishes,
      acknowledgements: summary.acknowledgements,
      rejections: summary.rejections,
      retries: summary.retries,
      repeatedOperations: summary.repeatedOperations,
      relayFanout: summary.relayFanout,
    }, {
      workflow: "feed-snapshot",
      openedConnections: 2,
      closedConnections: 2,
      connectionReuseCount: 1,
      requests: 3,
      closes: 3,
      returnedEvents: 2,
      eose: 3,
      publishes: 0,
      acknowledgements: 0,
      rejections: 0,
      retries: 0,
      repeatedOperations: 0,
      relayFanout: 1,
    });
    assert.ok(summary.returnedEventBytes > 0);
    assert.equal(summary.subscriptionLifetimesMs.length, 3);
    assert.ok(summary.subscriptionLifetimesMs.every((value) => value >= 0));
    assert.ok(summary.completionLatencyMs >= 0);

    const entries = harness.entries.slice(
      workflow.startIndex,
      workflow.completedIndex,
    );
    const requests = entries.filter((entry) => entry.type === "request");
    const requestSince = requests[0]?.filters[0]?.since;
    if (requestSince === undefined) {
      assert.fail("expected the root request to include a since boundary");
    }
    assert.ok(requestSince >= refreshStartedAt);
    assert.ok(requestSince <= refreshCompletedAt);
    assert.equal(requests[1]?.filters[0]?.since, requestSince);
    assert.deepEqual(
      requests.map((request) =>
        request.filters.map(({ since: _since, ...filter }) => filter),
      ),
      [
        [{ kinds: [1], limit: 500 }],
        [{ kinds: [1], "#e": [rootEvent.id], limit: 100 }],
        [{ kinds: [0], authors: [rootEvent.pubkey], limit: 1 }],
      ],
    );
    assert.ok(requests.every((request) => request.bytes > 0));
    assert.deepEqual(
      entries
        .filter((entry) => entry.type === "event-returned")
        .map((entry) => entry.eventId)
        .sort(),
      [replyEvent.id, rootEvent.id].sort(),
    );
    const requestedSubscriptionIds = requests
      .map((request) => request.subscriptionId)
      .sort();
    assert.deepEqual(
      entries
        .filter((entry) => entry.type === "eose")
        .map((entry) => entry.subscriptionId)
        .sort(),
      requestedSubscriptionIds,
    );
    assert.deepEqual(
      entries
        .filter((entry) => entry.type === "close")
        .map((entry) => entry.subscriptionId)
        .sort(),
      requestedSubscriptionIds,
    );
  } finally {
    await harness?.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
