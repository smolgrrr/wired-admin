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
  created_at: Math.floor(Date.now() / 1000),
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

    const snapshot = await service.refresh();
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
      relayFanout: 1,
    });
    assert.ok(summary.returnedEventBytes > 0);
    assert.equal(summary.subscriptionLifetimesMs.length, 3);
    assert.ok(summary.subscriptionLifetimesMs.every((value) => value >= 0));
    assert.ok(summary.completionLatencyMs >= 0);
  } finally {
    await harness?.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
