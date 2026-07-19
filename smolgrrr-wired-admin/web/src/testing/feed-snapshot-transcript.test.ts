import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeEvent, nip19 } from "nostr-tools";
import {
  createFeedSnapshotService,
  scheduleFeedSnapshotRefresh,
} from "../feed-snapshot-service.js";
import { createModerationService } from "../moderation.js";
import {
  RelayTranscriptHarness,
  RelayTranscriptSession,
  type RelayRequestController,
  type RelayTranscriptEntry,
} from "./relay-transcript.js";

const secretKey = new Uint8Array(32).fill(2);
const rootEvent = finalizeEvent(
  {
    created_at: 2_000_000_000,
    kind: 1,
    tags: [],
    content: "root",
  },
  secretKey,
);
const replyEvent = finalizeEvent(
  {
    created_at: rootEvent.created_at,
    kind: 1,
    tags: [["e", rootEvent.id, "", "reply"]],
    content: "reply",
  },
  secretKey,
);
const nestedReplyEvent = finalizeEvent(
  {
    created_at: replyEvent.created_at,
    kind: 1,
    tags: [["e", replyEvent.id, "", "reply"]],
    content: "nested reply",
  },
  secretKey,
);

test("feed snapshot exposes complete output and its relay transcript", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "wired-relay-transcript-"),
  );
  const harnesses: RelayTranscriptHarness[] = [];

  try {
    const session = new RelayTranscriptSession();
    let serveActivity = true;
    const options = {
      session,
      onRequest(request: RelayRequestController) {
        const [filter] = request.filters;
        if (filter?.["#e"]?.includes(replyEvent.id)) {
          request.sendEvent(nestedReplyEvent);
        } else if (filter?.["#e"]?.includes(rootEvent.id)) {
          request.sendEvent(replyEvent);
        } else if (serveActivity && filter?.kinds?.includes(1) && !filter.ids) {
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
      moderation: createModerationService(
        path.join(temporaryDirectory, "moderation.json"),
      ),
    });

    const sampleCount = process.env.RELAY_AUDIT_OUTPUT === "1" ? 20 : 1;
    const completionLatencies: number[] = [];
    let evidenceEntries: readonly RelayTranscriptEntry[] = [];
    for (let run = 0; run < sampleCount; run += 1) {
      const workflow = session.beginWorkflow(`feed-snapshot-${run + 1}`);
      const refreshStartedAt = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
      const manualRefresh = service.refresh();
      let scheduledRefresh: Promise<unknown> | undefined;
      const schedule = scheduleFeedSnapshotRefresh(
        () => {
          scheduledRefresh = service.refresh();
          return scheduledRefresh;
        },
        0.001,
        (error) => assert.fail(error instanceof Error ? error : String(error)),
      );
      const snapshot = await manualRefresh;
      schedule?.close();
      assert.ok(
        scheduledRefresh,
        "expected the scheduled trigger during manual refresh",
      );
      const coalescedSnapshot = await scheduledRefresh;
      const refreshCompletedAt = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
      await session.waitFor(
        (entries) =>
          entries.filter((entry) => entry.type === "close").length ===
          (run + 1) * 8,
      );
      workflow.complete();
      assert.strictEqual(coalescedSnapshot, snapshot);

      assert.deepEqual(
        Object.keys(snapshot.eventsById).sort(),
        [nestedReplyEvent.id, replyEvent.id, rootEvent.id].sort(),
      );
      assert.deepEqual(
        snapshot.processedEvents[0]?.replyIds.sort(),
        [nestedReplyEvent.id, replyEvent.id].sort(),
      );
      const summary = session.summary(workflow);
      assert.deepEqual(
        {
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
        },
        {
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
        },
      );
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
      assert.ok(
        requests.every((request) =>
          request.filters.every((filter) =>
            filter.kinds?.includes(1)
              ? filter.since === requestSince
              : filter.since === undefined,
          ),
        ),
      );
      const filterCounts = new Map<string, number>();
      requests.forEach((request) => {
        const filters = request.filters.map((filter) => {
          const withoutSince = { ...filter };
          delete withoutSince.since;
          return withoutSince;
        });
        const key = JSON.stringify(filters);
        filterCounts.set(key, (filterCounts.get(key) ?? 0) + 1);
      });
      assert.deepEqual(
        filterCounts,
        new Map([
          [JSON.stringify([{ kinds: [1], limit: 500 }]), 2],
          [
            JSON.stringify([{ "#e": [rootEvent.id], kinds: [1], limit: 100 }]),
            2,
          ],
          [
            JSON.stringify([{ "#e": [replyEvent.id], kinds: [1], limit: 100 }]),
            2,
          ],
          [
            JSON.stringify([
              { authors: [rootEvent.pubkey], kinds: [0], limit: 1 },
            ]),
            2,
          ],
        ]),
      );
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

    serveActivity = false;
    const incrementalWorkflow = session.beginWorkflow(
      "feed-snapshot-incremental-carry",
    );
    const incrementalSnapshot = await service.refresh();
    incrementalWorkflow.complete();
    assert.deepEqual(
      Object.keys(incrementalSnapshot.eventsById).sort(),
      [nestedReplyEvent.id, replyEvent.id, rootEvent.id].sort(),
    );
    assert.deepEqual(
      incrementalSnapshot.processedEvents[0]?.replyIds.sort(),
      [nestedReplyEvent.id, replyEvent.id].sort(),
    );

    if (process.env.RELAY_AUDIT_OUTPUT === "1") {
      const sorted = [...completionLatencies].sort((a, b) => a - b);
      const percentile = (value: number) =>
        sorted[Math.ceil((value / 100) * sorted.length) - 1] ?? 0;
      console.info(
        JSON.stringify({
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
        }),
      );
    }
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("feed snapshot resolves hinted context and selects newest relay metadata", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "wired-feed-metadata-"),
  );
  const harnesses: RelayTranscriptHarness[] = [];

  try {
    const session = new RelayTranscriptSession();
    const rootKey = new Uint8Array(32).fill(70);
    const referenceKey = new Uint8Array(32).fill(71);
    const referencedEvent = finalizeEvent(
      {
        created_at: 2_000_000_010,
        kind: 1,
        tags: [],
        content: "admin referenced context",
      },
      referenceKey,
    );
    let root: ReturnType<typeof finalizeEvent>;

    const listenBaseRelay = async (
      profileName: string,
      profileCreatedAt: number,
    ) =>
      RelayTranscriptHarness.listen({
        session,
        onRequest(request) {
          const [filter] = request.filters;
          if (filter?.authors && filter.kinds?.includes(0)) {
            [rootKey, referenceKey].forEach((key, index) =>
              request.sendEvent(
                finalizeEvent(
                  {
                    created_at: profileCreatedAt,
                    kind: 0,
                    tags: [],
                    content: JSON.stringify({
                      name: `${profileName}-${index}`,
                    }),
                  },
                  key,
                ),
              ),
            );
          } else if (
            filter?.kinds?.includes(1) &&
            !filter.ids &&
            !filter["#e"]
          ) {
            request.sendEvent(root);
          }
          request.sendEose();
        },
      });

    const olderRelay = await listenBaseRelay("older", 2_000_000_030);
    const newerRelay = await listenBaseRelay("newer", 2_000_000_040);
    const hintedRelay = await RelayTranscriptHarness.listen({
      session,
      onRequest(request) {
        if (request.filters[0]?.ids?.includes(referencedEvent.id)) {
          request.sendEvent(referencedEvent);
        }
        request.sendEose();
      },
    });
    harnesses.push(olderRelay, newerRelay, hintedRelay);
    const baseRelayUrls = [olderRelay.url, newerRelay.url];
    root = finalizeEvent(
      {
        created_at: 2_000_000_020,
        kind: 1,
        tags: [],
        content: `nostr:${nip19.neventEncode({
          id: referencedEvent.id,
          relays: [hintedRelay.url],
        })}`,
      },
      rootKey,
    );

    const service = createFeedSnapshotService({
      cacheFile: path.join(temporaryDirectory, "feed.json"),
      refreshSeconds: 300,
      ageHours: 24,
      timeoutMs: 1_000,
      replyLimit: 100,
      replyFetchDepth: 2,
      minPow: 0,
      powRelays: baseRelayUrls,
      enrichmentRelays: baseRelayUrls,
      threadRelays: baseRelayUrls,
      moderation: createModerationService(
        path.join(temporaryDirectory, "moderation.json"),
      ),
    });
    const workflow = session.beginWorkflow("admin-feed-reference-metadata");
    const snapshot = await service.refresh();
    await session.waitFor(
      (entries) =>
        entries.filter((entry) => entry.type === "connection-closed").length ===
          7 && entries.filter((entry) => entry.type === "close").length === 12,
    );
    workflow.complete();

    assert.deepEqual(
      Object.keys(snapshot.eventsById).sort(),
      [root.id, referencedEvent.id].sort(),
    );
    assert.deepEqual(snapshot.profiles[root.pubkey], { name: "newer-0" });
    assert.deepEqual(snapshot.profiles[referencedEvent.pubkey], {
      name: "newer-1",
    });
    const entries = session.entries.slice(
      workflow.startIndex,
      workflow.completedIndex,
    );
    const requests = entries.filter((entry) => entry.type === "request");
    const referenceRequests = requests.filter((request) =>
      request.filters[0]?.ids?.includes(referencedEvent.id),
    );
    assert.equal(referenceRequests.length, 3);
    assert.deepEqual(
      new Set(referenceRequests.map((request) => request.relayUrl)),
      new Set([...baseRelayUrls, hintedRelay.url]),
    );
    assert.deepEqual(
      {
        openedConnections: session.summary(workflow).openedConnections,
        closedConnections: session.summary(workflow).closedConnections,
        requests: session.summary(workflow).requests,
        closes: session.summary(workflow).closes,
        eose: session.summary(workflow).eose,
        returnedEvents: session.summary(workflow).returnedEvents,
        relayFanout: session.summary(workflow).relayFanout,
      },
      {
        openedConnections: 7,
        closedConnections: 7,
        requests: 12,
        closes: 12,
        eose: 12,
        returnedEvents: 7,
        relayFanout: 3,
      },
    );
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("feed snapshot retains complete output when one relay never sends EOSE", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "wired-feed-degraded-"),
  );
  const harnesses: RelayTranscriptHarness[] = [];

  try {
    const session = new RelayTranscriptSession();
    harnesses.push(
      await RelayTranscriptHarness.listen({
        session,
        onRequest(request) {
          const [filter] = request.filters;
          if (filter?.["#e"]?.includes(replyEvent.id)) {
            request.sendEvent(nestedReplyEvent, 5);
          } else if (filter?.["#e"]?.includes(rootEvent.id)) {
            request.sendEvent(replyEvent, 5);
          } else if (filter?.kinds?.includes(1) && !filter.ids) {
            request.sendEvent(rootEvent, 5);
          }
          request.sendEose(5);
        },
      }),
      await RelayTranscriptHarness.listen({ session, onRequest() {} }),
    );
    const relayUrls = harnesses.map((harness) => harness.url);
    const service = createFeedSnapshotService({
      cacheFile: path.join(temporaryDirectory, "feed.json"),
      refreshSeconds: 300,
      ageHours: 24,
      timeoutMs: 50,
      replyLimit: 100,
      replyFetchDepth: 2,
      minPow: 0,
      powRelays: relayUrls,
      enrichmentRelays: relayUrls,
      threadRelays: relayUrls,
      moderation: createModerationService(
        path.join(temporaryDirectory, "moderation.json"),
      ),
    });
    const workflow = session.beginWorkflow("admin-feed-no-eose-relay");
    const snapshot = await service.refresh();
    workflow.complete();

    assert.deepEqual(
      Object.keys(snapshot.eventsById).sort(),
      [nestedReplyEvent.id, replyEvent.id, rootEvent.id].sort(),
    );
    assert.deepEqual(
      {
        requests: session.summary(workflow).requests,
        returnedEvents: session.summary(workflow).returnedEvents,
        eose: session.summary(workflow).eose,
        relayFanout: session.summary(workflow).relayFanout,
      },
      {
        requests: 8,
        returnedEvents: 3,
        eose: 4,
        relayFanout: 2,
      },
    );
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("feed snapshot reuses activity connections while resolving a missing root", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "wired-feed-root-session-"),
  );
  const harnesses: RelayTranscriptHarness[] = [];

  try {
    const session = new RelayTranscriptSession();
    const rootKey = new Uint8Array(32).fill(81);
    const activityKey = new Uint8Array(32).fill(82);
    const missingRoot = finalizeEvent(
      {
        created_at: 2_000_000_000,
        kind: 1,
        tags: [],
        content: "root resolved after activity",
      },
      rootKey,
    );
    const activity = finalizeEvent(
      {
        created_at: 2_000_000_001,
        kind: 1,
        tags: [["e", missingRoot.id, "", "reply"]],
        content: "qualifying activity",
      },
      activityKey,
    );
    const options = {
      session,
      onRequest(request: RelayRequestController) {
        const [filter] = request.filters;
        if (filter?.ids?.includes(missingRoot.id)) {
          request.sendEvent(missingRoot);
        } else if (filter?.kinds?.includes(1) && !filter.ids && !filter["#e"]) {
          request.sendEvent(activity);
        } else if (filter?.["#e"]?.includes(missingRoot.id)) {
          request.sendEvent(activity);
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
      moderation: createModerationService(
        path.join(temporaryDirectory, "moderation.json"),
      ),
    });

    const workflow = session.beginWorkflow("admin-feed-missing-root-session");
    const snapshot = await service.refresh();
    await session.waitFor(
      (entries) =>
        entries.filter((entry) => entry.type === "connection-closed").length >=
        4,
    );
    workflow.complete();

    assert.deepEqual(
      Object.keys(snapshot.eventsById).sort(),
      [activity.id, missingRoot.id].sort(),
    );
    assert.deepEqual(
      {
        openedConnections: session.summary(workflow).openedConnections,
        closedConnections: session.summary(workflow).closedConnections,
        requests: session.summary(workflow).requests,
        relayFanout: session.summary(workflow).relayFanout,
      },
      {
        openedConnections: 4,
        closedConnections: 4,
        requests: 8,
        relayFanout: 2,
      },
    );
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("feed snapshot queries hints only for references missing from configured coverage", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "wired-feed-targeted-hints-"),
  );
  const harnesses: RelayTranscriptHarness[] = [];

  try {
    const session = new RelayTranscriptSession();
    const configuredReference = finalizeEvent(
      {
        created_at: 2_000_000_050,
        kind: 1,
        tags: [],
        content: "configured admin reference",
      },
      new Uint8Array(32).fill(83),
    );
    const hintedReference = finalizeEvent(
      {
        created_at: 2_000_000_051,
        kind: 1,
        tags: [],
        content: "hinted admin reference",
      },
      new Uint8Array(32).fill(84),
    );
    let referenceRoot: ReturnType<typeof finalizeEvent>;
    const configuredHarness = await RelayTranscriptHarness.listen({
      session,
      onRequest(request) {
        const [filter] = request.filters;
        if (filter?.ids?.includes(configuredReference.id)) {
          request.sendEvent(configuredReference);
        } else if (filter?.kinds?.includes(1) && !filter.ids && !filter["#e"]) {
          request.sendEvent(referenceRoot);
        }
        request.sendEose();
      },
    });
    const hintedHarness = await RelayTranscriptHarness.listen({
      session,
      onRequest(request) {
        if (request.filters[0]?.ids?.includes(hintedReference.id)) {
          request.sendEvent(hintedReference);
        }
        request.sendEose();
      },
    });
    harnesses.push(configuredHarness, hintedHarness);
    referenceRoot = finalizeEvent(
      {
        created_at: 2_000_000_052,
        kind: 1,
        tags: [],
        content: [configuredReference, hintedReference]
          .map(
            (event) =>
              `nostr:${nip19.neventEncode({
                id: event.id,
                relays: [hintedHarness.url],
              })}`,
          )
          .join(" "),
      },
      new Uint8Array(32).fill(85),
    );
    const service = createFeedSnapshotService({
      cacheFile: path.join(temporaryDirectory, "feed.json"),
      refreshSeconds: 300,
      ageHours: 24,
      timeoutMs: 1_000,
      replyLimit: 100,
      replyFetchDepth: 2,
      minPow: 0,
      powRelays: [configuredHarness.url],
      enrichmentRelays: [configuredHarness.url],
      threadRelays: [configuredHarness.url],
      moderation: createModerationService(
        path.join(temporaryDirectory, "moderation.json"),
      ),
    });

    const workflow = session.beginWorkflow("admin-feed-targeted-hints");
    const snapshot = await service.refresh();
    await session.waitFor(
      (entries) =>
        entries.filter((entry) => entry.type === "connection-closed").length >=
        4,
    );
    workflow.complete();

    assert.deepEqual(
      Object.keys(snapshot.eventsById).sort(),
      [referenceRoot.id, configuredReference.id, hintedReference.id].sort(),
    );
    const referenceRequests = session.entries
      .slice(workflow.startIndex, workflow.completedIndex)
      .filter((entry) => entry.type === "request")
      .filter((entry) => entry.filters[0]?.ids);
    assert.equal(referenceRequests.length, 2);
    assert.deepEqual(referenceRequests[0]?.filters, [
      {
        ids: [configuredReference.id, hintedReference.id],
        kinds: [1],
        limit: 2,
      },
    ]);
    assert.equal(referenceRequests[0]?.relayUrl, configuredHarness.url);
    assert.deepEqual(referenceRequests[1]?.filters, [
      { ids: [hintedReference.id], kinds: [1], limit: 1 },
    ]);
    assert.equal(referenceRequests[1]?.relayUrl, hintedHarness.url);
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("feed snapshot cancellation cleans relay work and retains the prior snapshot", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "wired-feed-cancellation-"),
  );
  const harnesses: RelayTranscriptHarness[] = [];
  let persistedSnapshot: ReturnType<
    ReturnType<typeof createFeedSnapshotService>["current"]
  > = null;
  let blockNextPersistence = false;
  let resolvePersistenceStarted: (() => void) | null = null;
  let releasePersistence!: () => void;

  try {
    const session = new RelayTranscriptSession();
    let stalled = false;
    const pendingRequests: RelayRequestController[] = [];
    const respond = (request: RelayRequestController) => {
      const [filter] = request.filters;
      if (filter?.kinds?.includes(1) && !filter.ids && !filter["#e"]) {
        request.sendEvent(rootEvent);
      }
      request.sendEose();
    };
    const options = {
      session,
      onRequest(request: RelayRequestController) {
        if (stalled) {
          pendingRequests.push(request);
          return;
        }
        respond(request);
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
      moderation: createModerationService(
        path.join(temporaryDirectory, "moderation.json"),
      ),
      async persistSnapshot(nextSnapshot) {
        if (blockNextPersistence) {
          blockNextPersistence = false;
          resolvePersistenceStarted?.();
          await new Promise<void>((resolve) => {
            releasePersistence = resolve;
          });
        }
        persistedSnapshot = nextSnapshot;
      },
    });
    const previousSnapshot = await service.refresh();
    const previousClosedConnections = session.entries.filter(
      (entry) => entry.type === "connection-closed",
    ).length;

    stalled = true;
    const controller = new AbortController();
    const cancelledRefresh = service.refresh({ signal: controller.signal });
    await session.waitFor(
      (entries) =>
        entries.filter((entry) => entry.type === "connection-opened").length >=
          previousClosedConnections + 2 &&
        entries.filter((entry) => entry.type === "request").length >= 7,
    );
    controller.abort();
    await assert.rejects(
      cancelledRefresh,
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(
      service.status().refreshing,
      false,
      "cancelled refresh settled before local relay ownership was cleaned",
    );
    await session.waitFor(
      (entries) =>
        entries.filter((entry) => entry.type === "connection-closed").length >=
        previousClosedConnections + 2,
    );

    assert.strictEqual(service.current(), previousSnapshot);
    assert.equal(service.lastRefreshError(), null);

    stalled = false;
    pendingRequests.length = 0;
    const recoveredSnapshot = await service.refresh();
    assert.deepEqual(
      Object.keys(recoveredSnapshot.eventsById),
      Object.keys(previousSnapshot.eventsById),
    );

    blockNextPersistence = true;
    const persistenceStarted = new Promise<void>((resolve) => {
      resolvePersistenceStarted = resolve;
    });
    const persistenceController = new AbortController();
    const persistenceCancellation = service.refresh({
      signal: persistenceController.signal,
    });
    await persistenceStarted;
    persistenceController.abort();
    releasePersistence();
    await assert.rejects(persistenceCancellation, { name: "AbortError" });
    assert.strictEqual(service.current(), recoveredSnapshot);
    assert.strictEqual(persistedSnapshot, recoveredSnapshot);

    stalled = true;
    const joiningController = new AbortController();
    const cancelledOwner = service.refresh({
      signal: joiningController.signal,
    });
    const survivingOwner = service.refresh();
    await session.waitFor(() => pendingRequests.length >= 2);
    assert.ok(pendingRequests.length >= 2);
    joiningController.abort();
    await assert.rejects(cancelledOwner, { name: "AbortError" });
    stalled = false;
    pendingRequests.splice(0).forEach(respond);
    const coalescedSnapshot = await survivingOwner;
    assert.deepEqual(
      Object.keys(coalescedSnapshot.eventsById),
      Object.keys(previousSnapshot.eventsById),
    );
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("closing the feed refresh scheduler aborts its active ownership", async () => {
  const activeSignals: AbortSignal[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let onErrorCalls = 0;
  const schedule = scheduleFeedSnapshotRefresh(
    (signal) => {
      activeSignals.push(signal);
      if (activeSignals.length >= 2) resolveStarted();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    0.001,
    () => {
      onErrorCalls += 1;
    },
  );

  assert.ok(schedule);
  await started;
  schedule.close();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(activeSignals.length >= 2);
  assert.ok(activeSignals.every((signal) => signal.aborted));
  assert.equal(onErrorCalls, 0);
});
