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
  RelayTranscriptSession,
  type RelayRequestController,
  type RelayTranscriptEntry,
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
const nestedReplyEvent = finalizeEvent({
  created_at: replyEvent.created_at,
  kind: 1,
  tags: [["e", replyEvent.id, "", "reply"]],
  content: "nested reply",
}, secretKey);

test("feed snapshot exposes complete output and its relay transcript", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "wired-relay-transcript-"));
  const harnesses: RelayTranscriptHarness[] = [];

  try {
    const session = new RelayTranscriptSession();
    const options = {
      session,
      onRequest(request: RelayRequestController) {
        const [filter] = request.filters;
        if (filter?.["#e"]?.includes(replyEvent.id)) {
          request.sendEvent(nestedReplyEvent);
        } else if (filter?.["#e"]?.includes(rootEvent.id)) {
          request.sendEvent(replyEvent);
        } else if (filter?.kinds?.includes(1) && !filter.ids) {
          request.sendEvent(rootEvent);
        }
        request.sendEose();
      },
    };
    harnesses.push(
      await RelayTranscriptHarness.listen(options),
      await RelayTranscriptHarness.listen(options),
    );
    const relayUrls = harnesses.map((harness) => harness.url);
    const service = createFeedSnapshotService({
      cacheFile: path.join(temporaryDirectory, "feed.json"),
      refreshSeconds: 300,
      ageHours: 24,
      timeoutMs: 1_000,
      replyLimit: 100,
      replyFetchDepth: 2,
      minPow: 0,
      powRelays: relayUrls,
      enrichmentRelays: relayUrls,
      threadRelays: relayUrls,
      moderation: createModerationService(path.join(temporaryDirectory, "moderation.json")),
    });

    const sampleCount = process.env.RELAY_AUDIT_OUTPUT === "1" ? 20 : 1;
    const completionLatencies: number[] = [];
    let evidenceEntries: readonly RelayTranscriptEntry[] = [];
    for (let run = 0; run < sampleCount; run += 1) {
      const workflow = session.beginWorkflow(`feed-snapshot-${run + 1}`);
      const refreshStartedAt = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
      const [snapshot, coalescedSnapshot] = await Promise.all([
        service.refresh(),
        service.refresh(),
      ]);
      const refreshCompletedAt = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
      await session.waitFor(
        (entries) => entries.filter((entry) => entry.type === "close").length ===
          (run + 1) * 8,
      );
      workflow.complete();
      assert.strictEqual(coalescedSnapshot, snapshot);

      assert.deepEqual(Object.keys(snapshot.eventsById).sort(), [
        nestedReplyEvent.id,
        replyEvent.id,
        rootEvent.id,
      ].sort());
      assert.deepEqual(snapshot.processedEvents[0]?.replyIds.sort(), [
        nestedReplyEvent.id,
        replyEvent.id,
      ].sort());
    const summary = session.summary(workflow);
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
      workflow: `feed-snapshot-${run + 1}`,
      openedConnections: 4,
      closedConnections: 4,
      connectionReuseCount: 4,
      requests: 8,
      closes: 8,
      returnedEvents: 6,
      eose: 8,
      publishes: 0,
      acknowledgements: 0,
      rejections: 0,
      retries: 0,
      repeatedOperations: 4,
      relayFanout: 2,
    });
    assert.ok(summary.returnedEventBytes > 0);
    assert.equal(summary.subscriptionLifetimesMs.length, 8);
    assert.ok(summary.subscriptionLifetimesMs.every((value) => value >= 0));
    assert.ok(summary.completionLatencyMs >= 0);

    const entries = session.entries.slice(
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
    assert.ok(requests.every((request) =>
      request.filters[0]?.since === undefined || request.filters[0].since === requestSince
    ));
    const filterCounts = new Map<string, number>();
    requests.forEach((request) => {
      const filters = request.filters.map(({ since: _since, ...filter }) => filter);
      const key = JSON.stringify(filters);
      filterCounts.set(key, (filterCounts.get(key) ?? 0) + 1);
    });
    assert.deepEqual(filterCounts, new Map([
      [JSON.stringify([{ kinds: [1], limit: 500 }]), 2],
      [JSON.stringify([{ "#e": [rootEvent.id], kinds: [1], limit: 100 }]), 2],
      [JSON.stringify([{ "#e": [replyEvent.id], kinds: [1], limit: 100 }]), 2],
      [JSON.stringify([{ authors: [rootEvent.pubkey], kinds: [0], limit: 1 }]), 2],
    ]));
    assert.ok(requests.every((request) => request.bytes > 0));
    assert.deepEqual(
      entries
        .filter((entry) => entry.type === "event-returned")
        .map((entry) => entry.eventId)
        .sort(),
      [
        nestedReplyEvent.id,
        nestedReplyEvent.id,
        replyEvent.id,
        replyEvent.id,
        rootEvent.id,
        rootEvent.id,
      ].sort(),
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
      completionLatencies.push(summary.completionLatencyMs);
      evidenceEntries = entries;
    }

    if (process.env.RELAY_AUDIT_OUTPUT === "1") {
      const sorted = [...completionLatencies].sort((a, b) => a - b);
      const percentile = (value: number) =>
        sorted[Math.ceil((value / 100) * sorted.length) - 1] ?? 0;
      console.info(JSON.stringify({
        scenario: "wired-admin-feed-refresh-local-fixture",
        samples: sorted.length,
        completionLatencyMs: {
          p50: percentile(50),
          p95: percentile(95),
          samples: completionLatencies,
        },
        evidence: {
          filters: evidenceEntries
            .filter((entry) => entry.type === "request")
            .map((entry) => entry.filters),
          requestBytes: evidenceEntries
            .filter((entry) => entry.type === "request")
            .map((entry) => entry.bytes),
          returnedEventBytes: evidenceEntries
            .filter((entry) => entry.type === "event-returned")
            .map((entry) => entry.bytes),
          subscriptionLifetimesMs: evidenceEntries
            .filter((entry) => entry.type === "close")
            .map((entry) => entry.lifetimeMs),
        },
      }));
    }
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
